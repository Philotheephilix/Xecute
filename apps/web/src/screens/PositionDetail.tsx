import { useApp } from '../context/AppContext';

interface PositionDetailProps {
  params: Record<string, string>;
}

export default function PositionDetail({ params }: PositionDetailProps) {
  const { positions, popSubScreen } = useApp();

  const floorId = params?.['floorId'];
  const position = floorId ? positions.find((p) => p.floor_id === floorId) : null;

  return (
    <div className="tab-content bg-[#FAF9F6]">
      {/* Header with back button */}
      <div className="flex items-center gap-4 px-6 pt-8 pb-4">
        <button
          onClick={popSubScreen}
          className="w-11 h-11 bg-white border-2 border-[#111] rounded-[13px] shadow-neo-sm shadow-neo-active flex items-center justify-center"
          aria-label="Go back"
        >
          <svg className="w-5 h-5 stroke-current fill-none stroke-[2.5]" viewBox="0 0 24 24">
            <line x1="19" y1="12" x2="5" y2="12" />
            <polyline points="12 19 5 12 12 5" />
          </svg>
        </button>
        <span className="text-base font-extrabold text-[#111]">Floor Detail</span>
      </div>

      <div className="flex flex-col px-6 gap-5 pb-8">
        {position ? (
          <>
            {/* Asset info */}
            <div className="bg-white border-2 border-[#111] rounded-[18px] shadow-neo p-5 flex flex-col items-center gap-2">
              <div className="w-16 h-16 bg-[#9662FF] border-2 border-[#111] rounded-full shadow-neo-sm flex items-center justify-center">
                <svg className="w-8 h-8 stroke-white fill-none stroke-[2]" viewBox="0 0 24 24">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
              </div>
              <p className="text-2xl font-extrabold text-[#111]">{position.amount} {position.asset}</p>
              <span className={`px-3 py-1 rounded-full text-xs font-extrabold border border-[#111] ${
                position.status === 'active'
                  ? 'bg-[#29CEB4] text-[#111]'
                  : position.status === 'expired'
                    ? 'bg-gray-200 text-gray-600'
                    : 'bg-[#EF7B28] text-white'
              }`}>
                {position.status.toUpperCase()}
              </span>
            </div>

            {/* Floor details */}
            <div className="bg-white border-2 border-[#111] rounded-[18px] shadow-neo-sm p-5">
              <h3 className="text-xs font-extrabold text-gray-500 mb-3 uppercase tracking-wider">Floor Details</h3>
              <div className="flex flex-col gap-2">
                {position.floor_price_usd !== undefined && (
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-gray-600">Floor Price</span>
                    <span className="text-sm font-extrabold text-[#111]">
                      ${position.floor_price_usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                  </div>
                )}
                {position.protected_until && (
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-gray-600">Protected Until</span>
                    <span className="text-sm font-extrabold text-[#111]">
                      {new Date(position.protected_until).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    </span>
                  </div>
                )}
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-gray-600">Floor ID</span>
                  <span className="font-mono text-xs font-semibold text-gray-400 truncate max-w-[140px]">
                    {position.floor_id}
                  </span>
                </div>
              </div>
            </div>

            {/* Price chart placeholder */}
            <div className="bg-white border-2 border-[#111] rounded-[18px] shadow-neo-sm p-6 text-center">
              <p className="text-sm font-extrabold text-[#111]">Price history coming soon</p>
              <p className="text-xs font-semibold text-gray-500 mt-1">
                Track your floor position performance over time.
              </p>
            </div>
          </>
        ) : (
          <div className="bg-white border-2 border-[#111] rounded-[18px] shadow-neo-sm p-6 text-center">
            <p className="text-sm font-extrabold text-[#111]">Position not found</p>
            <p className="text-xs font-semibold text-gray-500 mt-1">
              This floor position may have been removed.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
