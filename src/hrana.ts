import type {
  Batch,
  BatchStep,
  ProtocolVersion,
  RowsResult,
  Stream,
} from "@libsql/hrana-client";
import { BatchCond } from "@libsql/hrana-client/lib-esm/batch.js";
import { Stmt } from "@libsql/hrana-client/lib-esm/stmt.js";
import {
  ProtoError,
  ProtocolVersionError,
  ResponseError,
  ClientError,
  ClosedError,
  HttpServerError,
  InternalError,
  WebSocketError,
} from "@libsql/hrana-client/lib-esm/errors.js";
import type {
  InStatement,
  ResultSet,
  Transaction,
  TransactionMode,
} from "./api.js";
import { LibsqlError } from "./api.js";
import type { SqlCache } from "./sql_cache.js";
import { transactionModeToBegin, ResultSetImpl } from "./util.js";

export abstract class HranaTransaction implements Transaction {
  #mode: TransactionMode;
  #version: ProtocolVersion;
  // Promise that is resolved when the BEGIN statement completes, or `undefined` if we haven't executed the
  // BEGIN statement yet.
  #started: Promise<void> | undefined;

  /** @private */
  constructor(mode: TransactionMode, version: ProtocolVersion) {
    this.#mode = mode;
    this.#version = version;
    this.#started = undefined;
  }

  /** @private */
  abstract _getStream(): Stream;
  /** @private */
  abstract _getSqlCache(): SqlCache;

  abstract close(): void;
  abstract get closed(): boolean;

  execute(stmt: InStatement): Promise<ResultSet> {
    return this.batch([stmt]).then((results) => results[0]);
  }

  async batch(stmts: Array<InStatement>): Promise<Array<ResultSet>> {
    const stream = this._getStream();
    if (stream.closed) {
      throw new LibsqlError(
        "Cannot execute statements because the transaction is closed",
        "TRANSACTION_CLOSED"
      );
    }

    try {
      const hranaStmts = stmts.map(stmtToHrana);

      let rowsPromises: Array<Promise<RowsResult | undefined>>;
      if (this.#started === undefined) {
        // The transaction hasn't started yet, so we need to send the BEGIN statement in a batch with
        // `hranaStmts`.

        this._getSqlCache().apply(hranaStmts);
        const batch = stream.batch(this.#version >= 3);
        const beginStep = batch.step();
        const beginPromise = beginStep.run(transactionModeToBegin(this.#mode));

        // Execute the `hranaStmts` only if the BEGIN succeeded, to make sure that we don't execute it
        // outside of a transaction.
        let lastStep = beginStep;
        rowsPromises = hranaStmts.map((hranaStmt) => {
          const stmtStep = batch.step().condition(BatchCond.ok(lastStep));
          if (this.#version >= 3) {
            // If the Hrana version supports it, make sure that we are still in a transaction
            stmtStep.condition(BatchCond.not(BatchCond.isAutocommit(batch)));
          }

          const rowsPromise = stmtStep.query(hranaStmt);
          rowsPromise.catch(() => undefined); // silence Node warning
          lastStep = stmtStep;
          return rowsPromise;
        });

        // `this.#started` is resolved successfully only if the batch and the BEGIN statement inside
        // of the batch are both successful.
        this.#started = batch
          .execute()
          .then(() => beginPromise)
          .then(() => undefined);

        try {
          await this.#started;
        } catch (e) {
          // If the BEGIN failed, the transaction is unusable and we must close it. However, if the
          // BEGIN suceeds and `hranaStmts` fail, the transaction is _not_ closed.
          this.close();
          throw e;
        }
      } else {
        if (this.#version < 3) {
          // The transaction has started, so we must wait until the BEGIN statement completed to make
          // sure that we don't execute `hranaStmts` outside of a transaction.
          await this.#started;
        } else {
          // The transaction has started, but we will use `hrana.BatchCond.isAutocommit()` to make
          // sure that we don't execute `hranaStmts` outside of a transaction, so we don't have to
          // wait for `this.#started`
        }

        this._getSqlCache().apply(hranaStmts);
        const batch = stream.batch(this.#version >= 3);

        let lastStep: BatchStep | undefined = undefined;
        rowsPromises = hranaStmts.map((hranaStmt) => {
          const stmtStep = batch.step();
          if (lastStep !== undefined) {
            stmtStep.condition(BatchCond.ok(lastStep));
          }
          if (this.#version >= 3) {
            stmtStep.condition(BatchCond.not(BatchCond.isAutocommit(batch)));
          }
          const rowsPromise = stmtStep.query(hranaStmt);
          rowsPromise.catch(() => undefined); // silence Node warning
          lastStep = stmtStep;
          return rowsPromise;
        });

        await batch.execute();
      }

      const resultSets = [];
      for (const rowsPromise of rowsPromises) {
        const rows = await rowsPromise;
        if (rows === undefined) {
          throw new LibsqlError(
            "Statement in a transaction was not executed, " +
              "probably because the transaction has been rolled back",
            "TRANSACTION_CLOSED"
          );
        }
        resultSets.push(resultSetFromHrana(rows));
      }
      return resultSets;
    } catch (e) {
      throw mapHranaError(e);
    }
  }

  async executeMultiple(sql: string): Promise<void> {
    const stream = this._getStream();
    if (stream.closed) {
      throw new LibsqlError(
        "Cannot execute statements because the transaction is closed",
        "TRANSACTION_CLOSED"
      );
    }

    try {
      if (this.#started === undefined) {
        // If the transaction hasn't started yet, start it now
        this.#started = stream
          .run(transactionModeToBegin(this.#mode))
          .then(() => undefined);
        try {
          await this.#started;
        } catch (e) {
          this.close();
          throw e;
        }
      } else {
        // Wait until the transaction has started
        await this.#started;
      }

      await stream.sequence(sql);
    } catch (e) {
      throw mapHranaError(e);
    }
  }

  async rollback(): Promise<void> {
    try {
      const stream = this._getStream();
      if (stream.closed) {
        return;
      }

      if (this.#started !== undefined) {
        // We don't have to wait for the BEGIN statement to complete. If the BEGIN fails, we will
        // execute a ROLLBACK outside of an active transaction, which should be harmless.
      } else {
        // We did nothing in the transaction, so there is nothing to rollback.
        return;
      }

      // Pipeline the ROLLBACK statement and the stream close.
      const promise = stream.run("ROLLBACK").catch((e) => {
        throw mapHranaError(e);
      });
      stream.closeGracefully();

      await promise;
    } catch (e) {
      throw mapHranaError(e);
    } finally {
      // `this.close()` may close the `hrana.Client`, which aborts all pending stream requests, so we
      // must call it _after_ we receive the ROLLBACK response.
      // Also note that the current stream should already be closed, but we need to call `this.close()`
      // anyway, because it may need to do more cleanup.
      this.close();
    }
  }

  async commit(): Promise<void> {
    // (this method is analogous to `rollback()`)
    try {
      const stream = this._getStream();
      if (stream.closed) {
        throw new LibsqlError(
          "Cannot commit the transaction because it is already closed",
          "TRANSACTION_CLOSED"
        );
      }

      if (this.#started !== undefined) {
        // Make sure to execute the COMMIT only if the BEGIN was successful.
        await this.#started;
      } else {
        return;
      }

      const promise = stream.run("COMMIT").catch((e) => {
        throw mapHranaError(e);
      });
      stream.closeGracefully();

      await promise;
    } catch (e) {
      throw mapHranaError(e);
    } finally {
      this.close();
    }
  }
}

export async function executeHranaBatch(
  mode: TransactionMode,
  version: ProtocolVersion,
  batch: Batch,
  hranaStmts: Array<Stmt>
): Promise<Array<ResultSet>> {
  const beginStep = batch.step();
  const beginPromise = beginStep.run(transactionModeToBegin(mode));

  let lastStep = beginStep;
  const stmtPromises = hranaStmts.map((hranaStmt) => {
    const stmtStep = batch.step().condition(BatchCond.ok(lastStep));
    if (version >= 3) {
      stmtStep.condition(BatchCond.not(BatchCond.isAutocommit(batch)));
    }

    const stmtPromise = stmtStep.query(hranaStmt);
    lastStep = stmtStep;
    return stmtPromise;
  });

  const commitStep = batch.step().condition(BatchCond.ok(lastStep));
  if (version >= 3) {
    commitStep.condition(BatchCond.not(BatchCond.isAutocommit(batch)));
  }
  const commitPromise = commitStep.run("COMMIT");

  const rollbackStep = batch
    .step()
    .condition(BatchCond.not(BatchCond.ok(commitStep)));
  rollbackStep.run("ROLLBACK").catch((_) => undefined);

  await batch.execute();

  const resultSets = [];
  await beginPromise;
  for (const stmtPromise of stmtPromises) {
    const hranaRows = await stmtPromise;
    if (hranaRows === undefined) {
      throw new LibsqlError(
        "Statement in a batch was not executed, probably because the transaction has been rolled back",
        "TRANSACTION_CLOSED"
      );
    }
    resultSets.push(resultSetFromHrana(hranaRows));
  }
  await commitPromise;

  return resultSets;
}

export function stmtToHrana(stmt: InStatement): Stmt {
  if (typeof stmt === "string") {
    return new Stmt(stmt);
  }

  const hranaStmt = new Stmt(stmt.sql);
  if (Array.isArray(stmt.args)) {
    hranaStmt.bindIndexes(stmt.args);
  } else {
    for (const [key, value] of Object.entries(stmt.args)) {
      hranaStmt.bindName(key, value);
    }
  }

  return hranaStmt;
}

export function resultSetFromHrana(hranaRows: RowsResult): ResultSet {
  const columns = hranaRows.columnNames.map((c) => c ?? "");
  const columnTypes = hranaRows.columnDecltypes.map((c) => c ?? "");
  const rows = hranaRows.rows;
  const rowsAffected = hranaRows.affectedRowCount;
  const lastInsertRowid =
    hranaRows.lastInsertRowid !== undefined
      ? hranaRows.lastInsertRowid
      : undefined;
  return new ResultSetImpl(
    columns,
    columnTypes,
    rows,
    rowsAffected,
    lastInsertRowid
  );
}

export function mapHranaError(e: unknown): unknown {
  if (e instanceof ClientError) {
    const code = mapHranaErrorCode(e);
    return new LibsqlError(e.message, code, e);
  }
  return e;
}

function mapHranaErrorCode(e: ClientError): string {
  if (e instanceof ResponseError && e.code !== undefined) {
    return e.code;
  } else if (e instanceof ProtoError) {
    return "HRANA_PROTO_ERROR";
  } else if (e instanceof ClosedError) {
    return e.cause instanceof ClientError
      ? mapHranaErrorCode(e.cause)
      : "HRANA_CLOSED_ERROR";
  } else if (e instanceof WebSocketError) {
    return "HRANA_WEBSOCKET_ERROR";
  } else if (e instanceof HttpServerError) {
    return "SERVER_ERROR";
  } else if (e instanceof ProtocolVersionError) {
    return "PROTOCOL_VERSION_ERROR";
  } else if (e instanceof InternalError) {
    return "INTERNAL_ERROR";
  } else {
    return "UNKNOWN";
  }
}
