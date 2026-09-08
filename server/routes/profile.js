import { Router } from 'express';
import multer from 'multer';
import { authenticateAccess } from '../middleware/auth.js';
import { rateLimiter } from '../middleware/rateLimiter.js';
import PetRepo from '../models/PetRepository.js';
import PostRepo from '../models/PostRepository.js';
import UserRepo from '../models/UserRepository.js';
import ProfileViewRepo from '../models/ProfileViewRepository.js';
import { uploadWithQuota } from '../services/mediaService.js';
import config from '../config.js';
import SpotlightRepo from '../models/SpotlightRepository.js';
import db from '../db/connection.js';
import { sendRealtimeNotification } from '../socket/notifications.js';
import { canAddPet, canUseSuperSniff } from '../services/premiumGate.js';
import { sendServerError } from '../utils/errors.js';

const router = Router();
router.use(authenticateAccess);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    const allowed = [...config.ALLOWED_IMAGE_TYPES, ...config.ALLOWED_VIDEO_TYPES];
    cb(null, allowed.includes(file.mimetype));
  }
});

// ══════════════════════════════════════════════════════════════
// SPECIFIC LITERAL ROUTES FIRST
// (must come before /:id so Express doesn't treat "places-autocomplete",
//  "my-pets", etc. as an :id param and crash with NaN)
// ══════════════════════════════════════════════════════════════

// Google Places Autocomplete (New) — returns predictions as the user types
router.get('/places-autocomplete', async (req, res) => {
  try {
    const q = req.query.q;
    if (!q || !q.trim()) return res.json({ results: [] });

    const apiKey = process.env.GOOGLE_PLACES_API_KEY;
    if (!apiKey) {
      console.warn('[places-autocomplete] GOOGLE_PLACES_API_KEY not set');
      return res.json({ results: [] });
    }

    // Bias toward the requesting user's saved pet location, if available
    const pet = await PetRepo.findByUserId(req.user.id);
    const hasLoc = !!(pet && pet.latitude && pet.longitude);

    const body = {
      input: q,
      includedRegionCodes: ['in'],
    };
    if (hasLoc) {
      body.locationBias = {
        circle: {
          center: { latitude: pet.latitude, longitude: pet.longitude },
          radius: 50000, // 50km bias radius; still allows farther matches, just ranked lower
        },
      };
    }

    const response = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('[places-autocomplete] Google error:', response.status, errText);
      return res.json({ results: [] });
    }

    const data = await response.json();
    const suggestions = data.suggestions || [];

    const results = suggestions
      .filter(s => s.placePrediction)
      .map(s => ({
        place_id: s.placePrediction.placeId,
        display_name: s.placePrediction.text?.text || '',
        main_text: s.placePrediction.structuredFormat?.mainText?.text || '',
        secondary_text: s.placePrediction.structuredFormat?.secondaryText?.text || '',
      }));

    res.json({ results });
  } catch (err) {
    console.error('[/places-autocomplete error]', err.message);
    res.json({ results: [] });
  }
});

// Google Place Details (New) — resolves a place_id to exact lat/lng + formatted address
router.get('/place-details', async (req, res) => {
  try {
    const placeId = req.query.place_id;
    if (!placeId) return res.status(400).json({ error: 'MISSING_PLACE_ID' });

    const apiKey = process.env.GOOGLE_PLACES_API_KEY;
    if (!apiKey) {
      console.warn('[place-details] GOOGLE_PLACES_API_KEY not set');
      return res.status(500).json({ error: 'SERVER_ERROR', message: 'Places API not configured' });
    }

    const response = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
      method: 'GET',
      headers: {
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'id,displayName,formattedAddress,location',
      },
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('[place-details] Google error:', response.status, errText);
      return res.status(502).json({ error: 'PLACES_API_ERROR', message: 'Could not resolve place details' });
    }

    const data = await response.json();
    res.json({
      place_id: data.id,
      display_name: data.formattedAddress || data.displayName?.text || '',
      name: data.displayName?.text || '',
      lat: data.location?.latitude,
      lng: data.location?.longitude,
    });
  } catch (err) {
    console.error('[/place-details error]', err.message);
    sendServerError(res, err);
  }
});

router.get('/my-pets', async (req, res) => {
  try {
    const pets = await PetRepo.findAllByUserId(req.user.id);
    const activePet = await PetRepo.getActivePet(req.user.id);
    res.json({ pets, activePet });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.post('/switch-pet', async (req, res) => {
  try {
    const { petId } = req.body;
    if (!petId) return res.status(400).json({ error: 'MISSING_PET_ID', message: 'petId is required' });

    const targetPet = await PetRepo.findById(parseInt(petId, 10));
    if (!targetPet) {
      return res.status(404).json({ error: 'PET_NOT_FOUND', message: 'Pet profile not found' });
    }

    if (targetPet.user_id !== req.user.id) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'You do not own this pet profile' });
    }

    await db.run('UPDATE users SET active_pet_id = ? WHERE id = ?', [targetPet.id, req.user.id]);
    const switchedPet = await PetRepo.getActivePet(req.user.id);
    const allPets = await PetRepo.findAllByUserId(req.user.id);

    res.json({ success: true, pet: switchedPet, allPets });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.post('/block', rateLimiter(config.RATE_LIMIT.POST), async (req, res) => {
  try {
    const { blockedUserId } = req.body;
    if (!blockedUserId) return res.status(400).json({ error: 'BAD_REQUEST', message: 'blockedUserId is required' });
    if (req.user.id === parseInt(blockedUserId)) return res.status(400).json({ error: 'BAD_REQUEST', message: 'You cannot block yourself' });
    if (!(await UserRepo.findById(parseInt(blockedUserId)))) {
      return res.status(404).json({ error: 'USER_NOT_FOUND' });
    }
    await UserRepo.blockUser(req.user.id, parseInt(blockedUserId));
    res.json({ success: true, message: 'User blocked successfully' });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.post('/unblock', rateLimiter(config.RATE_LIMIT.POST), async (req, res) => {
  try {
    const { blockedUserId } = req.body;
    if (!blockedUserId) return res.status(400).json({ error: 'BAD_REQUEST', message: 'blockedUserId is required' });
    await UserRepo.unblockUser(req.user.id, parseInt(blockedUserId));
    res.json({ success: true, message: 'User unblocked successfully' });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.get('/blocked', async (req, res) => {
  try {
    const blockedIds = await UserRepo.getBlockedUserIds(req.user.id);
    res.json({ blockedUserIds: blockedIds });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.post('/location', rateLimiter(config.RATE_LIMIT.POST), async (req, res) => {
  try {
    const pet = await PetRepo.findByUserId(req.user.id);
    if (!pet) return res.status(404).json({ error: 'NO_PET' });

    const latitude = parseFloat(req.body.latitude);
    const longitude = parseFloat(req.body.longitude);
    const accuracy = parseFloat(req.body.accuracy) || null;
    const heading = parseFloat(req.body.heading) || null;
    const speed = parseFloat(req.body.speed) || null;

    if (isNaN(latitude) || isNaN(longitude)) {
      return res.status(400).json({ error: 'INVALID_COORDINATES' });
    }

    const timestamp = new Date().toISOString();
    const updated = await PetRepo.update(pet.id, {
      latitude,
      longitude,
      last_updated_location_timestamp: timestamp
    });

    const io = req.app.get('io');
    if (io) {
      // Scoped to the 'meet_live' room (sockets that opted in via
      // 'join_meet' -- see socket/meet.js), not a global broadcast. Every
      // connected socket used to receive every user's live GPS coordinates
      // regardless of relevance; see AUDIT_REPORT.md.
      io.to('meet_live').emit('location_updated', {
        pet_id: pet.id,
        latitude,
        longitude,
        accuracy,
        heading,
        speed,
        last_updated_location_timestamp: timestamp,
        pet: updated
      });
    }

    res.json({ success: true, pet: updated });
  } catch (err) {
    sendServerError(res, err);
  }
});

// ══════════════════════════════════════════════════════════════
// GENERAL PROFILE ROUTES
// ══════════════════════════════════════════════════════════════

router.get('/', async (req, res) => {
  try {
    const pet = await PetRepo.findByUserId(req.user.id);
    if (!pet) return res.json({ pet: null, posts: [] });
    const stats = await PetRepo.getProfileWithStats(pet.id);
    if (stats) {
      const champ = await SpotlightRepo.isChampion(stats.id, stats.latitude, stats.longitude, req.query.cycleStart);
      if (champ) {
        stats.is_champion = true;
        stats.champion_area = champ.area;
      }
    }
    const posts = await PostRepo.getByPetId(pet.id);
    res.json({ pet: stats, posts });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.post('/', upload.single('avatar'), async (req, res) => {
  try {
    const io = req.app.get('io');
    const petCheck = await canAddPet(req.user.id, io);
    if (!petCheck.allowed) {
      return res.status(403).json({
        error: petCheck.reason,
        message: `Free accounts can have up to ${petCheck.limit} pet profile${petCheck.limit === 1 ? '' : 's'}. Upgrade to Premium for unlimited pets.`,
        plan: petCheck.plan,
        limit: petCheck.limit,
      });
    }

    let avatarUrl = null;
    if (req.file) {
      const uploaded = await uploadWithQuota(req.user.id, req.file, 'avatars');
      avatarUrl = uploaded.url;
    }

    const pet = await PetRepo.create({
      user_id: req.user.id,
      name: req.body.name,
      pet_username: req.body.pet_username ? `@${req.body.pet_username.replace('@', '')}` : null,
      type: req.body.type || 'dog',
      gender: req.body.gender || 'male',
      age: parseInt(req.body.age) || 1,
      breed_type: req.body.breed_type || 'Original',
      breed_name: req.body.breed_name || '',
      avatar_url: avatarUrl,
      vaccinated: req.body.vaccinated === 'true' || req.body.vaccinated === true ? 1 : 0,
      pet_kyc: req.body.pet_kyc === 'true' || req.body.pet_kyc === true ? 1 : 0,
      latitude: parseFloat(req.body.latitude) || null,
      longitude: parseFloat(req.body.longitude) || null,
      location_text: req.body.location_text || '',
      country: req.body.country || '',
      state: req.body.state || '',
      city: req.body.city || '',
      area: req.body.area || '',
      bio: req.body.bio || '',
      pawsitive_score: null,
    });
    res.status(201).json(pet);
  } catch (err) {
    sendServerError(res, err);
  }
});

router.put('/', upload.single('avatar'), async (req, res) => {
  try {
    const pet = await PetRepo.findByUserId(req.user.id);
    if (!pet) return res.status(404).json({ error: 'NO_PET' });

    const updates = {};
    const fields = ['name', 'pet_username', 'type', 'gender', 'breed_type', 'breed_name', 'bio', 'location_text', 'country', 'state', 'city', 'area'];
    fields.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
    if (req.body.age) updates.age = parseInt(req.body.age);
    if (req.body.latitude !== undefined && req.body.latitude !== '' && req.body.latitude !== null) updates.latitude = parseFloat(req.body.latitude);
    if (req.body.longitude !== undefined && req.body.longitude !== '' && req.body.longitude !== null) updates.longitude = parseFloat(req.body.longitude);
    if (req.body.vaccinated !== undefined) updates.vaccinated = req.body.vaccinated === 'true' ? 1 : 0;
    if (req.body.pet_kyc !== undefined) updates.pet_kyc = req.body.pet_kyc === 'true' ? 1 : 0;

    if (req.file) {
      const uploaded = await uploadWithQuota(req.user.id, req.file, 'avatars');
      updates.avatar_url = uploaded.url;
    }

    const updated = await PetRepo.update(pet.id, updates);
    const io = req.app.get('io');
    if (io) {
      io.emit('profile_updated', { pet_id: pet.id, pet: updated });
    }
    res.json(updated);
  } catch (err) {
    sendServerError(res, err);
  }
});

router.patch('/pawsitive', async (req, res) => {
  try {
    const pet = await PetRepo.findByUserId(req.user.id);
    if (!pet) return res.status(404).json({ error: 'NO_PET' });

    const score = parseInt(req.body.score);
    if (isNaN(score) || score < 0 || score > 100) {
      return res.status(400).json({ error: 'INVALID_SCORE', message: 'Score must be 0–100' });
    }

    const updated = await PetRepo.updatePawsitiveScore(pet.id, score);
    const io = req.app.get('io');
    if (io) {
      io.emit('profile_updated', { pet_id: pet.id, pet: updated });
    }
    res.json({ success: true, pawsitive_score: updated?.pawsitive_score ?? score });
  } catch (err) {
    sendServerError(res, err);
  }
});

// PATCH /api/profile/super-sniff — toggle stealth browsing (see POST /:id/view)
// Premium-gated: only turning it ON is checked -- a downgraded user must
// always be able to turn it back off regardless of their current plan.
router.patch('/super-sniff', async (req, res) => {
  try {
    const enabled = req.body.enabled === true || req.body.enabled === 'true';

    if (enabled) {
      const io = req.app.get('io');
      const check = await canUseSuperSniff(req.user.id, io);
      if (!check.allowed) {
        return res.status(403).json({ error: check.reason, message: 'Super Sniff is a Premium feature.', plan: check.plan });
      }
    }

    await UserRepo.setSuperSniffStatus(req.user.id, enabled);
    res.json({ success: true, super_sniff_enabled: enabled ? 1 : 0 });
  } catch (err) {
    sendServerError(res, err);
  }
});

// ── Dynamic /:id route MUST come last ──
router.get('/:id', async (req, res) => {
  try {
    const petId = parseInt(req.params.id, 10);
    if (isNaN(petId)) return res.status(400).json({ error: 'INVALID_ID' });

    const stats = await PetRepo.getProfileWithStats(petId);
    if (!stats) return res.status(404).json({ error: 'NOT_FOUND' });
    const champ = await SpotlightRepo.isChampion(stats.id, stats.latitude, stats.longitude, req.query.cycleStart);
    if (champ) {
      stats.is_champion = true;
      stats.champion_area = champ.area;
    }
    const posts = await PostRepo.getByPetId(petId);
    res.json({ pet: stats, posts });
  } catch (err) {
    sendServerError(res, err);
  }
});

// POST /api/profile/:id/view — records a profile view and notifies the owner
// (reusing the same sendRealtimeNotification pattern as likes/comments/spotlight).
// Self-views are a silent no-op, and at most one notification fires per
// (viewer pet, viewed pet) pair per rolling 24h -- enforced atomically in
// ProfileViewRepo.claimNotification, not something a client can bypass.
router.post('/:id/view', async (req, res) => {
  try {
    const viewedPetId = parseInt(req.params.id, 10);
    if (isNaN(viewedPetId)) return res.status(400).json({ error: 'INVALID_ID' });

    const viewedPet = await PetRepo.findById(viewedPetId);
    if (!viewedPet) return res.status(404).json({ error: 'NOT_FOUND' });

    if (viewedPet.user_id === req.user.id) {
      return res.json({ success: true, notified: false });
    }

    // Super Sniff: browse without leaving any trace. This skips the
    // profile_views claim/cooldown write too, not just the notification --
    // so a Super-Sniffed view has zero side effects. If Super Sniff is later
    // turned off, viewing the same profile again starts a fresh 24h window
    // exactly like a first-ever view, instead of silently having spent this
    // pair's notification slot on a view the owner was never told about.
    const viewerUser = await UserRepo.findById(req.user.id);
    if (viewerUser?.super_sniff_enabled) {
      return res.json({ success: true, notified: false });
    }

    const viewerPet = await PetRepo.findByUserId(req.user.id);
    if (!viewerPet) return res.json({ success: true, notified: false });

    const claimed = await ProfileViewRepo.claimNotification(viewerPet.id, viewedPetId);
    if (!claimed) {
      return res.json({ success: true, notified: false });
    }

    // Optional: a "sniff" originating from inside a PawCircle's member list
    // gets community-flavored copy instead of the generic "viewed your
    // profile" text -- same view record either way, just different wording.
    const communityId = parseInt(req.body?.communityId, 10);
    let communityName = null;
    if (!isNaN(communityId)) {
      const community = await db.get('SELECT name FROM communities WHERE id = ?', [communityId]);
      communityName = community?.name || null;
    }

    const io = req.app.get('io');
    if (io) {
      await sendRealtimeNotification(io, viewedPet.user_id, communityName ? {
        category: 'pawcircle',
        type: 'profile_sniff',
        title: `👃 ${viewerPet.name} from ${communityName} sniffed your profile!`,
        description: `${viewerPet.name} from ${communityName} sniffed your profile.`,
        avatarUrl: viewerPet.avatar_url || null,
        targetId: String(viewerPet.id),
        senderPetId: viewerPet.id,
        metadata: { community_id: communityId },
      } : {
        category: 'activity',
        type: 'profile_view',
        title: `👀 ${viewerPet.name} viewed your profile!`,
        description: `${viewerPet.name} checked out your profile on Sniffr.`,
        avatarUrl: viewerPet.avatar_url || null,
        targetId: String(viewerPet.id),
        senderPetId: viewerPet.id,
      });
    }

    res.json({ success: true, notified: true });
  } catch (err) {
    sendServerError(res, err);
  }
});

export default router;