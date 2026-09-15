import { useNavigate } from 'react-router-dom';

export default function NotFoundPage() {
  const navigate = useNavigate();

  return (
    <div className="bg-background text-on-surface min-h-screen flex items-center justify-center overflow-hidden selection:bg-primary-container selection:text-on-primary-container">
      <div className="fixed inset-0 bg-gradient-to-br from-primary to-primary-fixed-dim opacity-10"></div>

      <span className="material-symbols-outlined absolute text-[25rem] -top-24 -left-32 rotate-12 text-primary opacity-[0.05] pointer-events-none z-0" style={{ fontVariationSettings: "'FILL' 1" }}>pets</span>
      <span className="material-symbols-outlined absolute text-[18rem] -bottom-12 -right-16 -rotate-12 text-primary opacity-[0.05] pointer-events-none z-0" style={{ fontVariationSettings: "'FILL' 1" }}>pets</span>

      <main className="relative z-10 w-full max-w-md px-8 flex flex-col items-center justify-center space-y-8 text-center">
        <div className="relative">
          <div className="absolute inset-0 bg-primary-fixed-dim blur-[60px] opacity-20 rounded-full scale-150"></div>
          <div className="relative w-40 h-40 bg-surface-container-lowest shadow-[0_10px_30px_-15px_rgba(0,0,0,0.05)] rounded-[3.5rem] flex items-center justify-center">
            <span className="material-symbols-outlined text-primary text-6xl" style={{ fontVariationSettings: "'FILL' 1" }}>search_off</span>
          </div>
        </div>

        <div className="space-y-3">
          <h1 className="text-4xl font-headline font-extrabold tracking-tight text-primary leading-tight">
            404 - Lost the <span className="text-tertiary">scent</span>
          </h1>
          <p className="text-sm text-on-surface-variant leading-relaxed">
            This page doesn't exist or may have been moved.
          </p>
        </div>

        <button
          onClick={() => navigate('/')}
          className="bg-primary text-on-primary px-8 py-3 rounded-full font-label text-sm font-bold uppercase tracking-wider shadow-[0_20px_40px_-15px_rgba(0,0,0,0.2)]"
        >
          Back to Sniffr
        </button>
      </main>
    </div>
  );
}
