import { useState } from 'react';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import Portal from './Portal';

const SLIDES = [
  {
    emoji: '🎉',
    title: 'You\'re a Founding Member!',
    body: 'You were one of the first 100 pet parents to join Sniffr. As a thank you, we\'ve unlocked something special for you.',
  },
  {
    emoji: '👑',
    title: 'Sniffr Gold - On the House',
    body: 'Free Sniffr Gold, no strings attached: unlimited pet profiles, unlimited PawCircles, Undo Like, Super Sniff stealth browsing, and 2 Spotlight Boosts every cycle.',
  },
  {
    emoji: '🐾',
    title: 'Wear the Badge Proudly',
    body: 'Your founding-member status is yours to keep, and your Premium badge will show up everywhere your pet\'s name does - Meet, Feed, Spotlight, Chat, and PawCircle.',
  },
];

export default function WelcomeSlider() {
  const { updateUser } = useAuth();
  const [step, setStep] = useState(0);
  const [dismissing, setDismissing] = useState(false);

  const isLast = step === SLIDES.length - 1;
  const slide = SLIDES[step];

  const finish = async () => {
    if (dismissing) return;
    setDismissing(true);
    updateUser({ welcome_slider_seen: 1 });
    try {
      await api.post('/premium/welcome-seen');
    } catch (err) {
      console.error('Failed to record welcome slider seen:', err);
    }
  };

  if (dismissing) return null;

  return (
    <Portal>
    <div className="fixed inset-0 z-[500] bg-background text-on-surface flex items-center justify-center overflow-hidden selection:bg-primary-container selection:text-on-primary-container animate-fade-in">
      {/* Plush canvas background, matching LoadingPage.jsx */}
      <div className="fixed inset-0 bg-gradient-to-br from-primary to-primary-fixed-dim opacity-10" />
      <span className="material-symbols-outlined absolute text-[25rem] -top-24 -left-32 rotate-12 text-primary opacity-[0.05] pointer-events-none z-0" style={{ fontVariationSettings: "'FILL' 1" }}>pets</span>
      <span className="material-symbols-outlined absolute text-[18rem] -bottom-12 -right-16 -rotate-12 text-primary opacity-[0.05] pointer-events-none z-0" style={{ fontVariationSettings: "'FILL' 1" }}>pets</span>

      <button
        onClick={finish}
        className="absolute top-6 right-6 z-20 text-xs font-bold text-on-surface-variant hover:text-on-surface transition-colors"
      >
        Skip
      </button>

      <main className="relative z-10 w-full max-w-md px-8 flex flex-col items-center justify-center space-y-10">
        <div className="relative mt-4" key={step}>
          <div className="absolute inset-0 bg-primary-fixed-dim blur-[60px] opacity-20 rounded-full scale-150" />
          <div className="relative w-40 h-40 bg-surface-container-lowest shadow-[0_10px_30px_-15px_rgba(0,0,0,0.05)] rounded-[3.5rem] flex items-center justify-center animate-scale-up">
            <span className="text-7xl">{slide.emoji}</span>
          </div>
        </div>

        <div className="text-center space-y-4 animate-fade-in" key={`text-${step}`}>
          <h1 className="text-3xl font-headline font-extrabold tracking-tight text-primary leading-tight px-2">
            {slide.title}
          </h1>
          <p className="text-on-surface-variant text-sm leading-relaxed px-2">
            {slide.body}
          </p>
        </div>

        {/* Step dots */}
        <div className="flex items-center gap-2">
          {SLIDES.map((_, i) => (
            <div
              key={i}
              className={`h-2 rounded-full transition-all ${i === step ? 'w-6 bg-primary' : 'w-2 bg-primary/20'}`}
            />
          ))}
        </div>

        <button
          onClick={() => (isLast ? finish() : setStep(s => s + 1))}
          className="w-full py-4 bg-gradient-to-br from-primary to-primary-fixed-dim text-on-primary rounded-2xl font-bold text-base shadow-[0_20px_40px_-10px_rgba(244,167,185,0.4)] active:scale-[0.98] transition-transform flex items-center justify-center gap-2"
        >
          {isLast ? "Let's Get Sniffing" : 'Next'}
          <span className="material-symbols-outlined text-lg">{isLast ? 'pets' : 'arrow_forward'}</span>
        </button>
      </main>
    </div>
    </Portal>
  );
}
