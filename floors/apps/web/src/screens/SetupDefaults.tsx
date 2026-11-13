import { useState, useEffect } from 'react';
import type { Screen, AccountState } from '../App';
import { getSuggestions } from '../api/client';

interface Props {
  navigate: (to: Screen) => void;
  account: AccountState | null;
  setAccount: (a: AccountState | null) => void;
  className: string;
}

const FLOOR_OPTIONS = [
  { label: 'OFF', bps: 0 },
  { label: '5%', bps: 500 },
  { label: '10%', bps: 1000 },
  { label: '20%', bps: 2000 },
];

const DURATION_OPTIONS = [
  { label: '30 days', secs: 2592000 },
  { label: '90 days', secs: 7776000 },
  { label: '180 days', secs: 15552000 },
];

function estimateCostPct(bps: number, durationSecs: number): string {
  if (bps === 0) return '0';
  const daysRatio = durationSecs / 15552000; // relative to 180d max
  const raw = (bps / 10000) * 0.3 * daysRatio * 100;
  return raw.toFixed(2);
}

export default function SetupDefaults({ navigate, className }: Props) {
  const [selectedBps, setSelectedBps] = useState<number>(500);
  const [selectedDuration, setSelectedDuration] = useState<number>(2592000);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getSuggestions()
      .then(({ floor_bps, duration_secs }) => {
        if (!cancelled) {
          setSelectedBps(floor_bps);
          setSelectedDuration(duration_secs);
        }
      })
      .catch(() => {/* use defaults */})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const handleSave = () => {
    localStorage.setItem(
      'floors:floor_defaults',
      JSON.stringify({ bps: selectedBps, duration_secs: selectedDuration }),
    );
    navigate('fund');
  };

  const costPct = estimateCostPct(selectedBps, selectedDuration);

  return (
    <div className={className}>
      {/* Header row */}
      <div className="px-[18px] pt-14 flex items-center gap-3">
        <button
          onClick={() => navigate('enable-trading')}
          className="w-11 h-11 bg-white border-2 border-[#111] rounded-[13px] shadow-neo-sm shadow-neo-active flex items-center justify-center shrink-0"
          aria-label="Go back"
        >
          <svg className="w-5 h-5 stroke-current fill-none stroke-[2.5]" viewBox="0 0 24 24">
            <line x1="19" y1="12" x2="5" y2="12" />
            <polyline points="12 19 5 12 12 5" />
          </svg>
        </button>
      </div>

      <div className="flex flex-col px-6 pt-6 pb-10 gap-7">
        {/* Title */}
        <div>
          <h1 className="text-3xl font-extrabold text-[#111] leading-tight">
            🛡 Set Your Floor Defaults
          </h1>
          <p className="text-sm font-semibold text-gray-500 mt-1">
            Choose how much protection to apply when you buy.
          </p>
        </div>

        {/* Protection level selector */}
        <div>
          <p className="text-xs font-extrabold text-gray-500 uppercase tracking-wide mb-3">
            How much protection?
          </p>
          <div className="grid grid-cols-4 gap-2">
            {FLOOR_OPTIONS.map(({ label, bps }) => (
              <button
                key={bps}
                onClick={() => setSelectedBps(bps)}
                className={[
                  'h-14 border-2 border-[#111] rounded-[13px] font-extrabold text-sm shadow-neo-active',
                  selectedBps === bps
                    ? 'bg-[#29CEB4] text-white shadow-neo'
                    : 'bg-white text-[#111] shadow-neo-sm',
                ].join(' ')}
                disabled={loading}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Duration selector */}
        <div>
          <p className="text-xs font-extrabold text-gray-500 uppercase tracking-wide mb-3">
            How long?
          </p>
          <div className="grid grid-cols-3 gap-2">
            {DURATION_OPTIONS.map(({ label, secs }) => (
              <button
                key={secs}
                onClick={() => setSelectedDuration(secs)}
                className={[
                  'h-14 border-2 border-[#111] rounded-[13px] font-extrabold text-sm shadow-neo-active',
                  selectedDuration === secs
                    ? 'bg-[#29CEB4] text-white shadow-neo'
                    : 'bg-white text-[#111] shadow-neo-sm',
                ].join(' ')}
                disabled={loading}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Cost estimate */}
        {selectedBps > 0 && (
          <p className="text-sm font-bold text-[#29CEB4]">
            Floor protection costs ~{costPct}% of your buy amount
          </p>
        )}

        {/* CTAs */}
        <div className="flex flex-col gap-3 mt-2">
          <button
            onClick={handleSave}
            className="w-full h-14 bg-[#EF7B28] text-white border-2 border-[#111] rounded-[13px] text-base font-extrabold shadow-neo shadow-neo-active"
          >
            Save &amp; Continue
          </button>
          <button
            onClick={() => navigate('fund')}
            className="w-full h-14 bg-white text-[#111] border-2 border-[#111] rounded-[13px] text-base font-extrabold shadow-neo-sm shadow-neo-active"
          >
            Skip for now
          </button>
        </div>
      </div>
    </div>
  );
}
