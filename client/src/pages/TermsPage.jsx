import { useNavigate } from 'react-router-dom';

export default function TermsPage() {
  const navigate = useNavigate();

  return (
    <div className="bg-background text-on-surface min-h-screen pb-12 selection:bg-primary-container selection:text-on-primary-container">
      {/* Top Navigation Header */}
      <header className="fixed top-0 w-full z-50 bg-background/80 dark:bg-on-surface/80 backdrop-blur-lg shadow-[0_15px_40px_-15px_rgba(0,0,0,0.05)] border-b border-outline-variant/10">
        <div className="flex items-center justify-between px-6 py-4 w-full">
          <button onClick={() => navigate(-1)} className="active:scale-95 transition-transform duration-200 text-on-surface-variant hover:text-primary">
            <span className="material-symbols-outlined text-2xl">arrow_back</span>
          </button>
          <h1 className="text-2xl font-extrabold tracking-tighter text-primary dark:text-primary-fixed-dim">Terms of Service</h1>
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
            <div className="inline-flex items-center justify-center p-4 bg-secondary-container rounded-full mb-4 shadow-[0_10px_30px_-10px_rgba(168,216,234,0.4)]">
              <span className="material-symbols-outlined text-on-secondary-container text-3xl">gavel</span>
            </div>
            <h2 className="font-headline font-extrabold text-3xl text-on-surface tracking-tight mb-3">House Rules</h2>
            <p className="text-on-surface-variant text-sm leading-relaxed max-w-md mx-auto">
              Welcome to Sniffr! Let's keep the park clean and friendly for all paws. Here are the rules of the yard.
            </p>
            <div className="mt-6 flex justify-center gap-2">
              <span className="px-3 py-1 bg-surface-container-high text-on-surface-variant text-[10px] font-bold uppercase tracking-widest rounded-full">Effective: Oct 2026</span>
            </div>
          </section>

          {/* Terms Content Section */}
          <div className="group bg-surface-container-lowest p-8 rounded-xl shadow-[0_15px_40px_-15px_rgba(244,167,185,0.2)] transition-all hover:shadow-[0_20px_50px_-15px_rgba(244,167,185,0.4)]">
            <div className="flex items-start gap-5">
              <div className="w-12 h-12 flex-shrink-0 bg-primary-container rounded-lg flex items-center justify-center">
                <span className="material-symbols-outlined text-on-primary-container">menu_book</span>
              </div>
              <div className="space-y-3">
                <span className="text-[10px] font-bold uppercase tracking-widest text-primary">Agreement</span>
                <h3 className="font-headline font-bold text-xl text-on-surface">Terms & Conditions</h3>
                <div className="text-on-surface-variant text-sm leading-relaxed space-y-2">
                  <p className="font-bold pt-2">1. Welcome to Sniffr</p>
                  <p>By using Sniffr, you agree to these terms. Sniffr is a platform designed to connect pet owners for socialization, playdates, and community building. Our service is intended for users aged 13 and above.</p>
                  
                  <p className="font-bold pt-2">2. User Responsibilities</p>
                  <p>You are responsible for maintaining the security of your account credentials. You must provide accurate information about your pet(s). All content you share must be your own or used with permission. You agree not to impersonate other users or pets.</p>
                  
                  <p className="font-bold pt-2">3. Acceptable Use</p>
                  <p>You agree to use Sniffr respectfully and lawfully. Harassment, spam, or sharing inappropriate content will result in account suspension. All interactions should prioritize the safety and well-being of pets.</p>
                  
                  <p className="font-bold pt-2">4. Account & Safety</p>
                  <p>We recommend enabling two-factor authentication for enhanced security. Report any suspicious activity immediately. We reserve the right to suspend accounts that violate our community guidelines.</p>
                  
                  <p className="font-bold pt-2">5. Content Ownership</p>
                  <p>You retain ownership of content you post on Sniffr. By posting, you grant us a license to display and distribute your content within the platform. You can delete your content at any time.</p>
                  
                  <p className="font-bold pt-2">6. Limitations of Liability</p>
                  <p>Sniffr facilitates connections but is not responsible for interactions that occur outside the platform. We do not guarantee match compatibility. Always exercise caution when meeting in person.</p>
                </div>
              </div>
            </div>
          </div>

          {/* Security Recommendation Section */}
          <div className="group bg-surface-container-lowest p-8 rounded-xl shadow-[0_15px_40px_-15px_rgba(168,216,234,0.2)] transition-all">
            <div className="flex items-start gap-5">
              <div className="w-12 h-12 flex-shrink-0 bg-[rgba(255,183,77,0.2)] rounded-lg flex items-center justify-center">
                <span className="material-symbols-outlined text-[rgba(255,152,0,1)]">warning</span>
              </div>
              <div className="space-y-3">
                <span className="text-[10px] font-bold uppercase tracking-widest text-[rgba(255,152,0,1)]">Important</span>
                <h3 className="font-headline font-bold text-xl text-on-surface">Security Recommendation</h3>
                <p className="text-on-surface-variant text-sm leading-relaxed">
                  We strongly recommend enabling two-factor authentication to protect your account and your pet's profile. You can turn this on anytime from Settings → Account → PawPrint Verification.
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
            
            <div className="flex justify-center gap-6 pt-4 border-t border-outline-variant/10">
              <button onClick={() => navigate('/privacy')} className="text-sm font-bold text-on-surface-variant/60 hover:opacity-80 transition-opacity">Privacy</button>
              <button onClick={() => navigate('/terms')} className="text-sm font-bold text-primary hover:opacity-80 transition-opacity">Terms</button>
              <button onClick={() => navigate('/faq')} className="text-sm font-bold text-on-surface-variant/60 hover:opacity-80 transition-opacity">FAQ</button>
            </div>

            <p className="text-xs text-on-surface-variant mt-4">
              Questions? Contact us at support@sniffr.app
            </p>
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
