import { useNavigate } from 'react-router-dom';

export default function PrivacyPage() {
  const navigate = useNavigate();

  return (
    <div className="bg-background text-on-surface min-h-screen pb-12 selection:bg-primary-container selection:text-on-primary-container">
      {/* Top Navigation Header */}
      <header className="fixed top-0 w-full z-50 bg-background/80 dark:bg-on-surface/80 backdrop-blur-lg shadow-[0_15px_40px_-15px_rgba(0,0,0,0.05)] border-b border-outline-variant/10">
        <div className="flex items-center justify-between px-6 py-4 w-full">
          <button onClick={() => navigate(-1)} className="active:scale-95 transition-transform duration-200 text-on-surface-variant hover:text-primary">
            <span className="material-symbols-outlined text-2xl">arrow_back</span>
          </button>
          <h1 className="text-2xl font-extrabold tracking-tighter text-primary dark:text-primary-fixed-dim">Privacy Policy</h1>
          <div className="w-10 h-10 rounded-full bg-primary-container flex items-center justify-center overflow-hidden">
            <img alt="Logo" className="w-full h-full object-cover" src="/logo.png"/>
          </div>
        </div>
      </header>
      <main className="relative pt-24 pb-12 px-6 min-h-[884px] overflow-hidden">
        {/* Decorative Background Elements */}
        <div className="absolute -top-10 -right-10 w-64 h-64 bg-primary-container/20 blob-bg -z-10 blur-3xl rounded-[40%_60%_70%_30%/40%_50%_60%_50%]"></div>
        <div className="absolute top-1/2 -left-20 w-80 h-80 bg-secondary-container/20 blob-bg -z-10 blur-3xl rounded-[40%_60%_70%_30%/40%_50%_60%_50%]"></div>
        <div className="absolute bottom-10 right-0 opacity-[0.04] -z-10 transform rotate-12">
          <span className="material-symbols-outlined text-[12rem]" style={{ fontVariationSettings: "'FILL' 1" }}>pets</span>
        </div>
        <div className="absolute top-40 left-10 opacity-[0.04] -z-10 transform -rotate-12">
          <span className="material-symbols-outlined text-[8rem]" style={{ fontVariationSettings: "'FILL' 1" }}>potted_plant</span>
        </div>

        {/* Content Canvas */}
        <div className="max-w-3xl mx-auto space-y-6">
          {/* Hero Introduction */}
          <section className="text-center mb-10">
            <div className="inline-flex items-center justify-center p-4 bg-primary-container rounded-full mb-4 shadow-[0_10px_30px_-10px_rgba(244,167,185,0.4)]">
              <span className="material-symbols-outlined text-on-primary-container text-3xl">policy</span>
            </div>
            <h2 className="font-headline font-extrabold text-3xl text-on-surface tracking-tight mb-3">Your Privacy Matters</h2>
            <p className="text-on-surface-variant text-sm leading-relaxed max-w-md mx-auto">
              At Sniffr, we treat your pet's data with the same care we give our own furry friends. Here's how we keep your tails wagging and your data safe.
            </p>
            <div className="mt-6 flex justify-center gap-2">
              <span className="px-3 py-1 bg-tertiary-container text-on-tertiary-container text-[10px] font-bold uppercase tracking-widest rounded-full">Updated: Oct 2026</span>
            </div>
          </section>

          {/* Introduction Section */}
          <div className="group bg-surface-container-lowest p-8 rounded-xl shadow-[0_15px_40px_-15px_rgba(168,216,234,0.3)] transition-all hover:shadow-[0_20px_50px_-15px_rgba(168,216,234,0.4)]">
            <div className="flex items-start gap-5">
              <div className="w-12 h-12 flex-shrink-0 bg-secondary-container rounded-lg flex items-center justify-center">
                <span className="material-symbols-outlined text-on-secondary-container">waving_hand</span>
              </div>
              <div className="space-y-3">
                <span className="text-[10px] font-bold uppercase tracking-widest text-secondary-fixed-dim">Welcome</span>
                <h3 className="font-headline font-bold text-xl text-on-surface">Please Read</h3>
                <div className="text-on-surface-variant text-sm leading-relaxed space-y-2">
                  <p>Sniffr is committed to protecting your privacy. This Privacy Policy explains how we collect, use, and safeguard your information in compliance with Indian laws, including the Information Technology Act, 2000 and applicable data protection rules.</p>
                  <p className="font-bold pt-2">1. Information We Collect:</p>
                  <p>a. Personal Information: Name, phone number, email address</p>
                  <p>Location details: Account credentials</p>
                  <p>b. Pet Information: Breed, age, gender, Medical and vaccination details,Photos and descriptions</p>
                  <p>c. Usage Data: Device information</p>
                  <p>IP address: App activity and interactions</p>
                  <p className="font-bold pt-2">2. How We Use Your Information:</p>
                  <p>We use your data to: Create and manage user accounts, Match pets for breeding, Facilitate communication between users, Improve platform functionality, Ensure safety and prevent fraud.</p>
                  <p className="font-bold pt-2">3. Sharing of Information:</p>
                  <p>We may share data with: Other users (limited profile visibility), Service providers (payment processors, hosting services), Legal authorities when required by law. We do not sell your personal data.</p>
                  <p className="font-bold pt-2">4. Data Storage & Security:</p>
                  <p>Data is stored on secure servers. We implement reasonable security practices as per Indian IT rules. However, no system is completely secure.</p>
                  <p className="font-bold pt-2">5. User Rights:</p>
                  <p>You have the right to: Access your data, Update or correct information, Delete your account from Settings at any time.</p>
                  <p className="font-bold pt-2">6. Cookies & Tracking:</p>
                  <p>We may use cookies or similar technologies to: Enhance user experience, Analyze app performance.</p>
                </div>
              </div>
            </div>
          </div>

          {/* Your Rights Section */}
          <div className="group bg-surface-container-lowest p-8 rounded-xl shadow-[0_15px_40px_-15px_rgba(168,216,234,0.2)] transition-all">
            <div className="flex items-start gap-5">
              <div className="w-12 h-12 flex-shrink-0 bg-secondary-container rounded-lg flex items-center justify-center">
                <span className="material-symbols-outlined text-on-secondary-container">lock</span>
              </div>
              <div className="space-y-3">
                <span className="text-[10px] font-bold uppercase tracking-widest text-secondary-fixed-dim">Control</span>
                <h3 className="font-headline font-bold text-xl text-on-surface">Your Rights</h3>
                <p className="text-on-surface-variant text-sm leading-relaxed">
                  You have full control over your information. You can access, update, or delete your account data at any time from Settings → Account → Delete Account.
                </p>
              </div>
            </div>
          </div>

          {/* Footer Contact */}
          <div className="py-12 text-center space-y-4">
            <div className="flex flex-col items-center mb-1">
              <img alt="Sniffr Logo" className="w-16 h-16 object-contain" src="/logo.png"/>
              <h3 className="font-headline font-bold text-xl text-primary mt-2">Sniffr</h3>
            </div>
            <div>
              <h4 className="font-headline font-bold text-on-surface">Still have questions?</h4>
              <p className="text-sm text-on-surface-variant">Our homans are here to help.</p>
            </div>
            <a className="inline-block px-8 py-3 bg-gradient-to-br from-primary to-primary-fixed-dim text-white font-bold rounded-full shadow-[0_10px_25px_-5px_rgba(244,167,185,0.4)] active:scale-95 transition-all" href="mailto:privacy@sniffr.app">
              Email Support
            </a>
            <div className="flex justify-center gap-6 pt-4 border-t border-outline-variant/10">
              <button onClick={() => navigate('/privacy')} className="text-sm font-bold text-primary hover:opacity-80 transition-opacity">Privacy</button>
              <button onClick={() => navigate('/terms')} className="text-sm font-bold text-on-surface-variant/60 hover:opacity-80 transition-opacity">Terms</button>
              <button onClick={() => navigate('/faq')} className="text-sm font-bold text-on-surface-variant/60 hover:opacity-80 transition-opacity">FAQ</button>
            </div>
            <p className="text-[10px] text-outline pt-4 uppercase tracking-widest">© 2026 Sniffrweb.com</p>
          </div>
        </div>

        {/* Corner Doodles */}
        <div className="fixed bottom-4 left-4 opacity-20 pointer-events-none">
          <span className="material-symbols-outlined text-[64px] grayscale mix-blend-multiply">pets</span>
        </div>
      </main>
    </div>
  );
}
