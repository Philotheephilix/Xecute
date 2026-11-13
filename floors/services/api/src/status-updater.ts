/**
 * Background job: polls 1Click for status updates on pending buy_submissions.
 * Runs every 2s via setInterval.
 */

import type postgres from 'postgres';

interface MinLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  debug(obj: Record<string, unknown>, msg?: string): void;
}

const ONE_CLICK_BASE = 'https://1click.chaindefuser.com';

interface BuySubmissionRow {
  status_id: string;
  deposit_address: string | null;
  intent_hash: string | null;
  status: string;
}

interface OneClickStatusResponse {
  status: string;
  swapDetails?: {
    nearTxHashes?: string[];
  };
}

async function pollOneStatus(
  db: postgres.Sql,
  logger: MinLogger,
  row: BuySubmissionRow,
): Promise<void> {
  const lookupAddress = row.deposit_address ?? row.intent_hash;
  if (!lookupAddress) return;

  try {
    const resp = await fetch(
      `${ONE_CLICK_BASE}/v0/status?depositAddress=${encodeURIComponent(lookupAddress)}`,
    );
    if (!resp.ok) return;

    const data = await resp.json() as OneClickStatusResponse;
    const apiStatus = (data.status ?? '').toUpperCase();

    let newStatus: string | null = null;
    let txHash: string | null = null;

    if (apiStatus === 'COMPLETED') {
      newStatus = 'done';
      txHash = data.swapDetails?.nearTxHashes?.[0] ?? null;
    } else if (
      apiStatus === 'FAILED' ||
      apiStatus === 'EXPIRED' ||
      apiStatus === 'REFUNDED'
    ) {
      newStatus = 'failed';
    }

    if (newStatus !== null) {
      await db`
        UPDATE api.buy_submissions
        SET status = ${newStatus},
            tx_hash = ${txHash},
            updated_at = NOW()
        WHERE status_id = ${row.status_id}
      `;

      logger.info(
        { status_id: row.status_id, newStatus, txHash, event: 'submission_status_updated' },
        'Submission status updated from 1Click',
      );
    }
  } catch (err) {
    logger.debug({ err, status_id: row.status_id }, 'Status poll error (transient)');
  }
}

export function startStatusUpdater(db: postgres.Sql, logger: MinLogger): NodeJS.Timeout {
  const interval = setInterval(async () => {
    try {
      const rows = await db<BuySubmissionRow[]>`
        SELECT status_id, deposit_address, intent_hash, status
        FROM api.buy_submissions
        WHERE status NOT IN ('done', 'failed')
          AND created_at > NOW() - INTERVAL '1 hour'
        LIMIT 50
      `;

      if (rows.length === 0) return;

      await Promise.allSettled(rows.map((row) => pollOneStatus(db, logger, row)));
    } catch (err) {
      logger.debug({ err }, 'Status updater poll cycle error');
    }
  }, 2_000);

  return interval;
}
