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
  { label: '10% floor', bps: 1000 },
  { label: '20% floor', bps: 2000 },
];

/** Slider range: 1 hour min, 2 days max (testnet) */
const DURATION_MIN_SECS = 3600;
const DURATION_MAX_SECS = 172800;
const DURATION_DEFAULT_SECS = 86400;
const SLIDER_STEPS = 48; // 1h granularity for 48 hours

function sliderToSecs(val: number): number {
  return Math.max(DURATION_MIN_SECS, Math.min(val * 3600, DURATION_MAX_SECS));
}

function secsToSlider(secs: number): number {
  return Math.max(1, Math.min(Math.round(secs / 3600), SLIDER_STEPS));
}

function formatDurationLabel(secs: number): string {
  const hours = Math.round(secs / 3600);
  if (hours < 24) return hours === 1 ? '1 hour' : `${hours} hours`;
  const days = hours / 24;
  if (Number.isInteger(days)) return days === 1 ? '1 day' : `${days} days`;
  return `${hours} hours`;
}

function estimateCostPct(bps: number, durationSecs: number): string {
  if (bps === 0) return '0';
  const daysRatio = durationSecs / (365 * 86400); // relative to 1 year
  const raw = (bps / 10000) * 0.3 * daysRatio * 100;
  return raw.toFixed(2);
}

export default function SetupDefaults({ navigate, className }: Props) {
  const [selectedBps, setSelectedBps] = useState<number>(1000);
  const [selectedDuration, setSelectedDuration] = useState<number>(DURATION_DEFAULT_SECS);
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
    navigate('enable-trading');
  };

  const costPct = estimateCostPct(selectedBps, selectedDuration);

  return (
    <div className={className}>
      {/* Header row */}
      <div className="px-[18px] pt-14 flex items-center gap-3">
        <button
          onClick={() => navigate('account-ready')}
          className="w-11 h-11 bg-white border-2 border-[#111] rounded-[13px] shadow-neo-sm shadow-neo-active flex items-center justify-center shrink-0"
          aria-label="Go back"
        >
          <svg className="w-5 h-5 stroke-current fill-none stroke-[2.5]" viewBox="0 0 24 24">
            <line x1="19" y1="12" x2="5" y2="12" />
            <polyline points="12 19 5 12 12 5" />
          </svg>
        </button>
        <span className="text-base font-extrabold text-[#111]">Floor Defaults</span>
      </div>

      <div className="flex flex-col px-6 pt-6 pb-10 gap-7">
        {/* H4: Loading indicator while fetching suggestions */}
        {loading && (
          <div className="flex items-center gap-3 px-1">
            <span className="w-5 h-5 border-2 border-[#111] border-t-transparent rounded-full animate-spin" />
            <span className="text-sm font-semibold text-gray-500">Loading suggestions…</span>
          </div>
        )}

        {/* Title */}
        <div>
          <h1 className="text-3xl font-extrabold text-[#111] leading-tight">
            Set Your Floor Defaults
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
          <div className="grid grid-cols-2 gap-3">
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

        {/* Duration slider */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-extrabold text-gray-500 uppercase tracking-wide">
              How long?
            </p>
            <span className="text-sm font-extrabold text-[#111]">
              {formatDurationLabel(selectedDuration)}
            </span>
          </div>
          <input
            type="range"
            min={1}
            max={SLIDER_STEPS}
            step={1}
            value={secsToSlider(selectedDuration)}
            onChange={(e) => setSelectedDuration(sliderToSecs(parseInt(e.target.value, 10)))}
            className="w-full h-1.5 rounded-full appearance-none cursor-pointer accent-[#29CEB4]"
            style={{
              background: `linear-gradient(to right, #29CEB4 ${((secsToSlider(selectedDuration) - 1) / (SLIDER_STEPS - 1)) * 100}%, #e5e7eb ${((secsToSlider(selectedDuration) - 1) / (SLIDER_STEPS - 1)) * 100}%)`,
            }}
            disabled={loading}
          />
          <div className="flex justify-between mt-1">
            <span className="text-[10px] font-semibold text-gray-400">1 hour</span>
            <span className="text-[10px] font-semibold text-gray-400">2 days</span>
          </div>
        </div>

        {/* Cost estimate */}
        {selectedBps > 0 && (
          <p className="text-sm font-bold text-gray-600">
            Floor protection costs ~{costPct}% of your buy amount
          </p>
        )}

        {/* CTAs */}
        <div className="flex flex-col gap-3 mt-2">
          <button
            onClick={handleSave}
            disabled={loading}
            className="w-full h-14 bg-[#EF7B28] text-white border-2 border-[#111] rounded-[13px] text-base font-extrabold shadow-neo shadow-neo-active disabled:opacity-60 disabled:cursor-not-allowed"
          >
            Save &amp; Continue
          </button>
          <button
            onClick={() => navigate('enable-trading')}
            disabled={loading}
            className="w-full h-14 bg-white text-[#111] border-2 border-[#111] rounded-[13px] text-base font-extrabold shadow-neo-sm shadow-neo-active disabled:opacity-60 disabled:cursor-not-allowed"
          >
            Skip for now
          </button>
        </div>
      </div>
    </div>
  );
}
