import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

const FAQ_ITEMS = [
  {
    q: "🐾 How do I set up my pet's profile?",
    a: "Right after signup we walk you through it: a good photo, name, breed, age, and a bio that shows off their personality. Is Biscuit a certified squirrel chaser? A professional nap enthusiast? This is the place to brag. You can add more pets later and switch your active pet anytime from your Profile page.",
  },
  {
    q: "🐶 How does matching actually work?",
    a: "Pop open the Meet tab and start browsing pets nearby. See one you like? Tap it. If their human likes your pet back, congrats, it's a match! A chat opens up automatically so you two (well, your humans) can start planning a playdate.",
  },
  {
    q: "💬 How do I message someone I matched with?",
    a: "Once you've matched, just head to Chat and say hello. You can send text, photos, videos, voice notes, or even propose a meetup spot and time, all without leaving the conversation.",
  },
  {
    q: "📍 Wait, is my exact location visible to everyone?",
    a: "Nope, and we take that seriously. Your precise coordinates are never broadcast publicly, they're only used to surface relevant nearby matches. Want to browse in stealth mode? Super Sniff (a Premium perk) lets you look around without showing up in anyone else's discovery feed.",
  },
  {
    q: "🚫 Someone's being weird. How do I block or report them?",
    a: "Open their profile or your chat with them, tap the ⋮ menu, and hit Block or Report. Once blocked, they can't message you, match with you, or see your activity again. Every report gets reviewed by an actual human on our team, not a bot.",
  },
  {
    q: "👑 What do I actually get with Sniffr Premium?",
    a: "Depends on the plan (Plus, Gold, or Platinum), but the full lineup includes unlimited pet profiles, unlimited PawCircles, Undo Like for those 'wait, no' moments, Super Sniff stealth browsing, and Spotlight Boosts to get your pet noticed. Check Settings → Premium for the full breakdown.",
  },
  {
    q: "💳 How do I pay for Premium, and is it actually safe?",
    a: "Right now payments go through UPI: you send the payment, upload a screenshot plus the transaction ID, and our team manually confirms it, usually within 24 hours. One important thing: we will never, ever ask for your card PIN, OTP, or banking password. If someone claiming to be Sniffr asks for those, it's not us.",
  },
  {
    q: "🔑 I forgot my password. Now what?",
    a: "No panic needed. On the sign-in screen, tap 'Forgot password?' and pop in your email or username. If an account matches, we'll email a reset link, valid for 1 hour, then it expires for your safety.",
  },
  {
    q: "🐕‍🦺 What's this PawPrint verification thing?",
    a: "PawPrint is our name for two-factor authentication: an extra one-time code emailed to you at sign-in, on top of your password. Totally optional, but a smart move for keeping your account (and your pet's honor) safe. Flip it on anytime under Settings → Account → PawPrint Verification.",
  },
  {
    q: "🐾 What in the world is a PawCircle?",
    a: "Think of it as a clubhouse for pet people with something in common: a breed, a neighborhood, a shared obsession with squeaky toys. Join one from the Community tab, or start your own and invite the crew.",
  },
  {
    q: "😢 I want to delete my account. How?",
    a: "Head to Settings → Account → Delete Account. Fair warning: this permanently wipes your profile, pets, posts, matches, and messages, and there's no undo button for this one. Take a breath before you confirm.",
  },
  {
    q: "🐛 I hit a bug, or just need to talk to a human.",
    a: "We're all ears. Email us at support@sniffr.app and someone from the team will get back to you as soon as we possibly can.",
  },
];

function FAQItem({ item, isOpen, onToggle }) {
  return (
    <div className="bg-surface-container-lowest rounded-xl shadow-[0_15px_40px_-15px_rgba(244,167,185,0.2)] overflow-hidden transition-all">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between gap-4 text-left p-6"
      >
        <span className="font-headline font-bold text-sm md:text-base text-on-surface">{item.q}</span>
        <span className={`material-symbols-outlined text-on-surface-variant flex-shrink-0 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}>
          expand_more
        </span>
      </button>
      {isOpen && (
        <div className="px-6 pb-6 -mt-1">
          <p className="text-on-surface-variant text-sm leading-relaxed">{item.a}</p>
        </div>
      )}
    </div>
  );
}

export default function FAQPage() {
  const navigate = useNavigate();
  const [openIndex, setOpenIndex] = useState(0);

  return (
    <div className="bg-background text-on-surface min-h-screen pb-12 selection:bg-primary-container selection:text-on-primary-container">
      <header className="fixed top-0 w-full z-50 bg-background/80 dark:bg-on-surface/80 backdrop-blur-lg shadow-[0_15px_40px_-15px_rgba(0,0,0,0.05)] border-b border-outline-variant/10">
        <div className="flex items-center justify-between px-6 py-4 w-full">
          <button onClick={() => navigate(-1)} className="active:scale-95 transition-transform duration-200 text-on-surface-variant hover:text-primary">
            <span className="material-symbols-outlined text-2xl">arrow_back</span>
          </button>
          <h1 className="text-2xl font-extrabold tracking-tighter text-primary dark:text-primary-fixed-dim">FAQ</h1>
          <div className="w-10 h-10 rounded-full bg-primary-container flex items-center justify-center overflow-hidden">
            <img alt="Logo" className="w-full h-full object-cover" src="/logo.png" />
          </div>
        </div>
      </header>

      <main className="relative pt-24 pb-12 px-6 overflow-hidden">
        <div className="absolute -top-10 -right-10 w-64 h-64 bg-primary-container/20 blob-bg -z-10 blur-3xl rounded-[40%_60%_70%_30%/40%_50%_60%_50%]"></div>
        <div className="absolute top-1/2 -left-20 w-80 h-80 bg-secondary-container/20 blob-bg -z-10 blur-3xl rounded-[40%_60%_70%_30%/40%_50%_60%_50%]"></div>

        <div className="max-w-3xl mx-auto space-y-6">
          <section className="text-center mb-10">
            <div className="inline-flex items-center justify-center p-4 bg-secondary-container rounded-full mb-4 shadow-[0_10px_30px_-10px_rgba(168,216,234,0.4)]">
              <span className="material-symbols-outlined text-on-secondary-container text-3xl">help</span>
            </div>
            <h2 className="font-headline font-extrabold text-3xl text-on-surface tracking-tight mb-3">Frequently Asked Questions</h2>
            <p className="text-on-surface-variant text-sm leading-relaxed max-w-md mx-auto">
              Everything you need to know about matching, messaging, safety, and Premium on Sniffr.
            </p>
          </section>

          <div className="space-y-4">
            {FAQ_ITEMS.map((item, idx) => (
              <FAQItem
                key={idx}
                item={item}
                isOpen={openIndex === idx}
                onToggle={() => setOpenIndex(openIndex === idx ? -1 : idx)}
              />
            ))}
          </div>

          <div className="py-12 text-center space-y-4">
            <div className="flex flex-col items-center mb-1">
              <img alt="Sniffr Logo" className="w-16 h-16 object-contain" src="/logo.png" />
              <h3 className="font-headline font-bold text-xl text-primary mt-2">Sniffr</h3>
            </div>
            <div>
              <h4 className="font-headline font-bold text-on-surface">Still have questions?</h4>
              <p className="text-sm text-on-surface-variant">Our humans are here to help.</p>
            </div>
            <a className="inline-block px-8 py-3 bg-gradient-to-br from-primary to-primary-fixed-dim text-white font-bold rounded-full shadow-[0_10px_25px_-5px_rgba(244,167,185,0.4)] active:scale-95 transition-all" href="mailto:support@sniffr.app">
              Email Support
            </a>
            <div className="flex justify-center gap-6 pt-4 border-t border-outline-variant/10">
              <button onClick={() => navigate('/privacy')} className="text-sm font-bold text-on-surface-variant/60 hover:opacity-80 transition-opacity">Privacy</button>
              <button onClick={() => navigate('/terms')} className="text-sm font-bold text-on-surface-variant/60 hover:opacity-80 transition-opacity">Terms</button>
              <button className="text-sm font-bold text-primary hover:opacity-80 transition-opacity">FAQ</button>
            </div>
            <p className="text-[10px] text-outline pt-4 uppercase tracking-widest">© 2026 Sniffrweb.com</p>
          </div>
        </div>
      </main>
    </div>
  );
}
