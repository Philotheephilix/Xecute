import type { Screen, AccountState } from '../App';

interface Props {
  navigate: (to: Screen) => void;
  account: AccountState | null;
  setAccount: (a: AccountState | null) => void;
  className: string;
}

export default function Welcome({ navigate, className }: Props) {
  return (
    <div className={className}>
      <div className="flex flex-col items-center justify-between min-h-full px-6 py-12">
        {/* Top spacer */}
        <div className="flex-1" />

        {/* Hero section */}
        <div className="flex flex-col items-center gap-6 w-full max-w-sm">
          {/* Floating badge */}
          <div className="animate-float">
            <span
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-[#EF7B28] text-white border-2 border-[#111] rounded-full text-sm font-extrabold shadow-neo"
              style={{ transform: 'rotate(5deg)' }}
            >
              ✦ Floors
            </span>
          </div>

          {/* Logo wordmark */}
          <h1 className="text-7xl font-black text-[#111] tracking-tight leading-none">
            Floors
          </h1>

          {/* Tagline */}
          <p className="text-xl font-bold text-gray-600 text-center leading-snug">
            Buy crypto on X.{' '}
            <span className="text-[#EF7B28] font-extrabold">Protected.</span>
          </p>

          {/* Feature pills */}
          <div className="flex flex-wrap justify-center gap-2 mt-2">
            {['Passkey secured', 'NEAR wallet', '1-tap buy'].map((feat) => (
              <span
                key={feat}
                className="px-3 py-1.5 bg-white border-2 border-[#111] rounded-full text-xs font-extrabold shadow-neo-sm"
              >
                {feat}
              </span>
            ))}
          </div>
        </div>

        <div className="flex-1" />

        {/* Bottom CTA section */}
        <div className="w-full max-w-sm flex flex-col gap-4">
          <button
            onClick={() => navigate('create-passkey')}
            className="w-full h-14 bg-[#EF7B28] text-white border-2 border-[#111] rounded-[13px] text-base font-extrabold shadow-neo shadow-neo-active transition-transform"
          >
            Get Started
          </button>

          <p className="text-center text-sm font-semibold text-gray-500">
            Already have an account?{' '}
            <button
              className="text-gray-700 font-bold underline underline-offset-2"
              onClick={() => navigate('portfolio')}
            >
              Sign in
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}
