import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import { getCurrentGPSLocation, getStoredLocation } from '../services/locationService';
import UpsellModal from '../components/UpsellModal';
import { isPremiumGateError, isQuotaExceededError, quotaUpsellCopy } from '../utils/premiumErrors';
import { validatePetUsername } from '../utils/petUsername';
import Portal from '../components/Portal';

export default function CreateProfilePage() {
  const { state } = useLocation();
  const petType = state?.petType || 'dog';
  const navigate = useNavigate();
  const { pet: activePet, allPets, updatePet, refreshProfile, switchPet } = useAuth();
  const [loading, setLoading] = useState(false);

  const storedLoc = getStoredLocation();
  const hasStoredLoc = Boolean(storedLoc?.country || storedLoc?.city || (storedLoc?.latitude && storedLoc?.longitude));

  const [gpsStatus, setGpsStatus] = useState(hasStoredLoc ? 'success' : '');
  const [createdPetModal, setCreatedPetModal] = useState(null);
  const [upsell, setUpsell] = useState(null); // { title, message } -- premium upsell modal

  const [form, setForm] = useState({
    name: '', 
    pet_username: '', 
    gender: 'male', 
    age: '',
    breed_type: 'Original', 
    breed_name: '', 
    vaccinated: false, 
    pet_kyc: false,
    bio: 'Wags and zoomies await!',
    country: storedLoc?.country || '',
    state: storedLoc?.state || '',
    city: storedLoc?.city || '',
    area: storedLoc?.area || '',
    latitude: storedLoc?.latitude || '',
    longitude: storedLoc?.longitude || ''
  });

  const update = (key, val) => setForm(prev => ({ ...prev, [key]: val }));

  const [gpsMessage, setGpsMessage] = useState('');

  const handleGPS = async () => {
    setGpsStatus('loading');
    setGpsMessage('');
    try {
      const loc = await getCurrentGPSLocation();
      setForm(prev => ({
        ...prev,
        latitude: loc.latitude,
        longitude: loc.longitude,
        country: loc.country || prev.country,
        state: loc.state || prev.state,
        city: loc.city || prev.city,
        area: loc.area || prev.area
      }));
      setGpsStatus('success');
      setGpsMessage('Location retrieved and filled successfully! 📍');
    } catch (err) {
      console.error(err);
      setGpsStatus('denied');
      setGpsMessage('Location permission is required for nearby features. You can grant permission in your browser or device settings.');
    }
  };

  const isLocationValid = (form.latitude && form.longitude) || (form.country.trim() && form.state.trim() && form.city.trim() && form.area.trim());

  const handleSubmit = async (e) => {
    e?.preventDefault();
    if (!isLocationValid) {
      alert("Please provide your location (GPS or Manual) to continue.");
      return;
    }
    const usernameError = validatePetUsername(form.pet_username);
    if (usernameError) {
      alert(usernameError);
      return;
    }
    setLoading(true);
    try {
      const fd = new FormData();
      Object.entries(form).forEach(([k, v]) => fd.append(k, v));
      fd.append('type', petType);

      const newPet = await api.post('/profile', fd);

      // Permanently save location to localStorage for offline/app consistency
      try {
        const savedLoc = {
          latitude: form.latitude ? parseFloat(form.latitude) : null,
          longitude: form.longitude ? parseFloat(form.longitude) : null,
          country: form.country || '',
          state: form.state || '',
          city: form.city || '',
          area: form.area || '',
          timestamp: Date.now()
        };
        localStorage.setItem('sniffr_user_gps_location', JSON.stringify(savedLoc));
      } catch (e) {
        /* ignore storage errors */
      }

      await refreshProfile();

      if (allPets && allPets.length > 0) {
        setCreatedPetModal(newPet);
      } else {
        updatePet(newPet);
        navigate('/home');
      }
    } catch (err) {
      if (isPremiumGateError(err)) {
        setUpsell({ title: 'Pet Profile Limit Reached', message: err.message });
      } else if (isQuotaExceededError(err)) {
        setUpsell(quotaUpsellCopy(err));
      } else if (err.code === 'USERNAME_TAKEN' || err.code === 'RESERVED_USERNAME' || err.code === 'INVALID_USERNAME_FORMAT') {
        alert(err.message);
      } else {
        console.error(err);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-background text-on-surface min-h-screen pb-32 relative selection:bg-primary-container">
      {/* Focused Header */}
      <header className="px-6 pt-8 flex items-center justify-between">
        <button onClick={() => navigate(-1)} className="w-12 h-12 flex items-center justify-center bg-surface-container-low rounded-full active:scale-90 transition-transform">
          <span className="material-symbols-outlined text-on-surface">arrow_back</span>
        </button>
        <div className="flex gap-1.5">
          <div className="h-2 w-8 bg-tertiary-fixed rounded-full"></div>
          <div className="h-2 w-8 bg-tertiary-fixed rounded-full"></div>
          <div className="h-2 w-12 bg-tertiary rounded-full"></div>
          <div className="h-2 w-8 bg-tertiary-fixed rounded-full"></div>
        </div>
        <div className="w-12 h-12"></div> {/* Spacer */}
      </header>

      <main className="px-8 mt-10">
        {/* Editorial Section */}
        <section className="mb-10 relative">
          <div className="absolute -top-6 -right-4 opacity-5 text-primary">
            <span className="material-symbols-outlined text-[120px]" style={{ fontVariationSettings: "'FILL' 1" }}>pets</span>
          </div>
          <h1 className="text-4xl font-extrabold tracking-tight text-on-surface mb-2 leading-tight">
            Create a <span className="text-tertiary">Pawsome</span> Profile
          </h1>
          <p className="text-on-surface-variant font-medium opacity-70">
            Tell us all the sweet details about your furry companion.
          </p>
        </section>

        {/* Profile Form */}
        <form className="space-y-8" onSubmit={handleSubmit} id="create-profile-form">
          {/* Basic Identity */}
          <div className="space-y-5">
            <div className="group">
              <label className="block text-[10px] font-bold uppercase tracking-[0.05em] text-on-tertiary-fixed-variant mb-2 ml-4">Pet Name</label>
              <input 
                className="w-full bg-surface-container-highest border-none rounded-lg px-6 py-4 focus:ring-2 focus:ring-tertiary/20 placeholder:text-stone-400 text-on-surface" 
                placeholder={petType === 'cat' ? 'e.g. Whiskers' : 'e.g. Marshmallow'} 
                type="text"
                value={form.name}
                onChange={(e) => update('name', e.target.value)}
                required
              />
            </div>
            <div className="group">
              <label className="block text-[10px] font-bold uppercase tracking-[0.05em] text-on-tertiary-fixed-variant mb-2 ml-4">Pet Username</label>
              <div className="relative">
                <span className="absolute left-6 top-1/2 -translate-y-1/2 text-tertiary font-bold">@</span>
                <input 
                  className="w-full bg-surface-container-highest border-none rounded-lg pl-10 pr-6 py-4 focus:ring-2 focus:ring-tertiary/20 placeholder:text-stone-400 text-on-surface" 
                  placeholder="handle" 
                  type="text"
                  value={form.pet_username}
                  onChange={(e) => update('pet_username', e.target.value)}
                  required
                />
              </div>
            </div>
          </div>

          {/* Gender Selection */}
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-[0.05em] text-on-tertiary-fixed-variant mb-3 ml-4">Gender</label>
            <div className="flex gap-4">
              <label className="flex-1 cursor-pointer">
                <input 
                  className="hidden peer" 
                  name="gender" 
                  type="radio" 
                  checked={form.gender === 'male'}
                  onChange={() => update('gender', 'male')}
                />
                <div className="bg-surface-container-low peer-checked:bg-tertiary-container peer-checked:text-on-tertiary-container text-stone-500 font-bold py-4 rounded-lg text-center transition-all flex items-center justify-center gap-2">
                  <span className="material-symbols-outlined text-lg">male</span>
                  Male
                </div>
              </label>
              <label className="flex-1 cursor-pointer">
                <input 
                  className="hidden peer" 
                  name="gender" 
                  type="radio"
                  checked={form.gender === 'female'}
                  onChange={() => update('gender', 'female')}
                />
                <div className="bg-surface-container-low peer-checked:bg-tertiary-container peer-checked:text-on-tertiary-container text-stone-500 font-bold py-4 rounded-lg text-center transition-all flex items-center justify-center gap-2">
                  <span className="material-symbols-outlined text-lg">female</span>
                  Female
                </div>
              </label>
            </div>
          </div>

          {/* Physical & Breed */}
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-1">
              <label className="block text-[10px] font-bold uppercase tracking-[0.05em] text-on-tertiary-fixed-variant mb-2 ml-4">Age</label>
              <input 
                className="w-full bg-surface-container-highest border-none rounded-lg px-6 py-4 focus:ring-2 focus:ring-tertiary/20 placeholder:text-stone-400 text-on-surface" 
                placeholder="Years" 
                type="number"
                value={form.age}
                onChange={(e) => update('age', e.target.value)}
              />
            </div>
            <div className="col-span-1">
              <label className="block text-[10px] font-bold uppercase tracking-[0.05em] text-on-tertiary-fixed-variant mb-2 ml-4">Breed Type</label>
              <div className="relative">
                <select 
                  className="w-full appearance-none bg-surface-container-highest border-none rounded-lg px-6 py-4 focus:ring-2 focus:ring-tertiary/20 text-on-surface"
                  value={form.breed_type}
                  onChange={(e) => update('breed_type', e.target.value)}
                >
                  <option>Original</option>
                  <option>Cross</option>
                </select>
                <span className="material-symbols-outlined absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none text-stone-400">expand_more</span>
              </div>
            </div>
            <div className="col-span-2">
              <label className="block text-[10px] font-bold uppercase tracking-[0.05em] text-on-tertiary-fixed-variant mb-2 ml-4">Breed Name</label>
              <input 
                className="w-full bg-surface-container-highest border-none rounded-lg px-6 py-4 focus:ring-2 focus:ring-tertiary/20 placeholder:text-stone-400 text-on-surface" 
                placeholder={petType === 'cat' ? 'e.g. Persian' : 'e.g. Golden Retriever'} 
                type="text"
                value={form.breed_name}
                onChange={(e) => update('breed_name', e.target.value)}
              />
            </div>
          </div>

          {/* Location Selection */}
          <div className="space-y-4">
            <label className="block text-[10px] font-bold uppercase tracking-[0.05em] text-on-tertiary-fixed-variant ml-4">Location (Required)</label>
            
            <button 
              type="button"
              onClick={handleGPS}
              className={`w-full py-4 rounded-xl font-bold text-sm flex items-center justify-center gap-2 transition-all active:scale-95 ${gpsStatus === 'success' ? 'bg-tertiary text-white shadow-lg' : 'bg-surface-container-highest text-on-surface hover:bg-tertiary/10'}`}
            >
              <span className="material-symbols-outlined">{gpsStatus === 'success' ? 'check_circle' : 'my_location'}</span>
              {gpsStatus === 'loading' ? 'Locating & Reverse Geocoding...' : gpsStatus === 'success' ? 'GPS Location Acquired' : 'Use Current GPS Location'}
            </button>

            {gpsMessage && (
              <div className={`p-3.5 rounded-2xl text-[11px] font-bold flex items-center gap-2.5 ${gpsStatus === 'success' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300 border border-emerald-200/50' : 'bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300 border border-amber-200/50'}`}>
                <span className="material-symbols-outlined text-base flex-shrink-0">{gpsStatus === 'success' ? 'verified' : 'location_disabled'}</span>
                <span>{gpsMessage}</span>
              </div>
            )}
            
            <div className="bg-surface-container-low p-5 rounded-2xl space-y-4 border border-outline-variant/20">
              <p className="text-xs font-bold text-on-surface-variant text-center uppercase tracking-widest mb-2">Or enter manually</p>
              <div className="grid grid-cols-2 gap-4">
                <input className="w-full bg-surface-container-highest border-none rounded-lg px-4 py-4 text-sm focus:ring-2 focus:ring-tertiary/20 placeholder:text-stone-400 font-bold text-on-surface" placeholder="Country" value={form.country} onChange={e => update('country', e.target.value)} />
                <input className="w-full bg-surface-container-highest border-none rounded-lg px-4 py-4 text-sm focus:ring-2 focus:ring-tertiary/20 placeholder:text-stone-400 font-bold text-on-surface" placeholder="State/Province" value={form.state} onChange={e => update('state', e.target.value)} />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <input className="w-full bg-surface-container-highest border-none rounded-lg px-4 py-4 text-sm focus:ring-2 focus:ring-tertiary/20 placeholder:text-stone-400 font-bold text-on-surface" placeholder="City" value={form.city} onChange={e => update('city', e.target.value)} />
                <input className="w-full bg-surface-container-highest border-none rounded-lg px-4 py-4 text-sm focus:ring-2 focus:ring-tertiary/20 placeholder:text-stone-400 font-bold text-on-surface" placeholder="Area" value={form.area} onChange={e => update('area', e.target.value)} />
              </div>
            </div>
          </div>

          {/* Verification Toggles */}
          <div className="bg-tertiary-container/30 p-6 rounded-lg space-y-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-tertiary-fixed flex items-center justify-center rounded-full text-tertiary">
                  <span className="material-symbols-outlined">vaccines</span>
                </div>
                <div>
                  <p className="font-bold text-on-tertiary-container">Vaccinated</p>
                  <p className="text-[10px] uppercase font-bold tracking-widest text-tertiary/60">Health Record Verified</p>
                </div>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input 
                  className="sr-only peer" 
                  type="checkbox" 
                  checked={form.vaccinated}
                  onChange={(e) => update('vaccinated', e.target.checked)}
                />
                <div className="w-14 h-8 bg-surface-container-high peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[4px] after:left-[4px] after:bg-white after:rounded-full after:h-6 after:w-6 after:transition-all peer-checked:bg-tertiary"></div>
              </label>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-tertiary-fixed flex items-center justify-center rounded-full text-tertiary">
                  <span className="material-symbols-outlined">verified_user</span>
                </div>
                <div>
                  <p className="font-bold text-on-tertiary-container">Pet KYC</p>
                  <p className="text-[10px] uppercase font-bold tracking-widest text-tertiary/60">Identity Shield</p>
                </div>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input 
                  className="sr-only peer" 
                  type="checkbox" 
                  checked={form.pet_kyc}
                  onChange={(e) => update('pet_kyc', e.target.checked)}
                />
                <div className="w-14 h-8 bg-surface-container-high peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[4px] after:left-[4px] after:bg-white after:rounded-full after:h-6 after:w-6 after:transition-all peer-checked:bg-tertiary"></div>
              </label>
            </div>
          </div>
        </form>
      </main>

      {/* Navigation Footer */}
      <footer className="fixed bottom-0 left-0 w-full bg-background/80 backdrop-blur-xl px-8 py-8 flex items-center justify-between z-50 border-t border-outline-variant/10">
        <button onClick={() => navigate(-1)} className="px-8 py-4 text-tertiary font-bold hover:opacity-70 active:scale-95 transition-all">
          Previous
        </button>
        <button 
          onClick={handleSubmit}
          disabled={loading || !form.name.trim() || !isLocationValid}
          className={`bg-gradient-to-br from-primary to-primary-fixed-dim text-white px-12 py-4 rounded-xl font-bold shadow-[0_20px_40px_-15px_rgba(244,167,185,0.4)] hover:shadow-none active:scale-95 transition-all flex items-center gap-2 ${loading || !form.name.trim() || !isLocationValid ? 'opacity-50 cursor-not-allowed' : ''}`}
        >
          {loading ? 'Wait...' : 'Next'}
          <span className="material-symbols-outlined">arrow_forward</span>
        </button>
      </footer>

      {/* Signature Texture Blobs */}
      <div className="fixed -bottom-10 -left-10 w-40 h-40 bg-tertiary-container/20 rounded-[42%_58%_70%_30%/45%_45%_55%_55%] -z-10 blur-2xl"></div>
      <div className="fixed top-1/4 -right-20 w-64 h-64 bg-primary-container/10 rounded-[42%_58%_70%_30%/45%_45%_55%_55%] -z-10 blur-3xl"></div>

      {/* Pet Joined Family Prompt Modal */}
      {createdPetModal && (
        <Portal>
        <div className="fixed inset-0 z-[250] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 select-none animate-fade-in">
          <div className="bg-white dark:bg-zinc-900 border border-outline-variant/10 rounded-[2.5rem] p-6 max-w-xs w-full shadow-2xl text-center space-y-4 animate-scale-up">
            <div className="w-16 h-16 rounded-full bg-rose-50 text-primary flex items-center justify-center mx-auto text-3xl font-bold">
              <span>🐾</span>
            </div>
            <div>
              <h3 className="font-extrabold text-base text-on-surface">{createdPetModal.name} has joined your family! 🐾</h3>
              <p className="text-xs text-zinc-400 font-medium mt-1">Would you like to switch to {createdPetModal.name}'s profile now or stay with {activePet?.name || 'your current pet'}?</p>
            </div>
            <div className="space-y-2 pt-2">
              <button
                onClick={() => {
                  const newId = createdPetModal.id;
                  setCreatedPetModal(null);
                  switchPet(newId);
                  navigate('/home');
                }}
                className="w-full py-3.5 bg-gradient-to-r from-primary to-primary-fixed-dim text-white font-extrabold text-xs uppercase tracking-wider rounded-full shadow-md transition-all active:scale-95"
              >
                Switch to {createdPetModal.name}
              </button>
              <button
                onClick={() => {
                  setCreatedPetModal(null);
                  navigate('/home');
                }}
                className="w-full py-3 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 text-zinc-700 dark:text-zinc-300 font-extrabold text-xs uppercase tracking-wider rounded-full transition-all active:scale-95"
              >
                Stay with {activePet?.name || 'Current Pet'}
              </button>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {upsell && (
        <UpsellModal title={upsell.title} message={upsell.message} onClose={() => setUpsell(null)} />
      )}
    </div>
  );
}
