import BaseRepository from './BaseRepository.js';
import db from '../db/connection.js';
import { hasCurrentAccess } from '../services/subscriptionService.js';

class PetRepository extends BaseRepository {
  constructor() { super('pets'); }

  async findAllByUserId(userId) {
    const pets = await db.all('SELECT * FROM pets WHERE user_id = ? ORDER BY id ASC', [userId]);
    return Promise.all(pets.map(p => this.attachCompletionStats(p)));
  }

  async getActivePet(userId) {
    try {
      const user = await db.get('SELECT active_pet_id FROM users WHERE id = ?', [userId]);
      if (user && user.active_pet_id) {
        const activePet = await db.get('SELECT * FROM pets WHERE id = ? AND user_id = ?', [user.active_pet_id, userId]);
        if (activePet) return this.attachCompletionStats(activePet);
      }
    } catch (e) {
      console.warn('getActivePet fallback query:', e.message);
    }
    const allPets = await db.all('SELECT * FROM pets WHERE user_id = ? ORDER BY id ASC', [userId]);
    if (!allPets || allPets.length === 0) return null;
    return this.attachCompletionStats(allPets[0]);
  }

  async findByUserId(userId) {
    return this.getActivePet(userId);
  }

  async findById(petId) {
    const pet = await db.get('SELECT * FROM pets WHERE id = ?', [petId]);
    if (!pet) return null;
    return this.attachCompletionStats(pet);
  }

  async attachCompletionStats(pet) {
    const requiredFields = [
      'name', 'pet_username', 'type', 'gender', 'age',
      'breed_name', 'avatar_url', 'bio', 'latitude', 'longitude',
      'country', 'state', 'city', 'area', 'vaccinated',
      'pawsitive_score'
    ];
    let completedCount = 0;
    const missing_fields = [];
    requiredFields.forEach(f => {
      if (pet[f] !== null && pet[f] !== '' && pet[f] !== undefined) {
        completedCount++;
      } else {
        missing_fields.push(f);
      }
    });

    const postCountRow = await db.get('SELECT COUNT(*) as count FROM posts WHERE pet_id = ? AND is_flagged = 0', [pet.id]);
    const postCount = postCountRow?.count || 0;
    if (postCount === 0) {
      missing_fields.push('gallery');
    } else {
      completedCount++;
    }

    const totalFields = requiredFields.length + 1;
    pet.completion_percent = Math.round((completedCount / totalFields) * 100);
    pet.missing_fields = missing_fields;

    // Premium badge -- centralized here since attachCompletionStats() is the
    // one place nearly every pet-returning query in the app already funnels
    // through (findAllByUserId, getActivePet, findById, getProfileWithStats),
    // so every pet object anywhere in the app gets is_premium for free
    // instead of each page re-deriving it.
    const owner = await db.get(
      'SELECT subscription_status, premium_badge_enabled, plan_expiry_date FROM users WHERE id = ?',
      [pet.user_id]
    );
    pet.is_premium = !!(owner && hasCurrentAccess(owner) && owner.premium_badge_enabled);

    return pet;
  }

  /**
   * Find nearby pets using a two-step approach:
   * 1. Bounding-box SQL prefilter (fast, uses composite geo index)
   * 2. Haversine JS calculation on the reduced set (accurate)
   *
   * Structure is ready for PostGIS migration — just replace step 1 with
   * ST_DWithin() when moving to PostgreSQL.
   */
  async findNearby(lat, lng, radiusKm, excludeIds = [], page = 1, limit = 10) {
    // Step 1: Bounding-box prefilter (1 degree latitude ≈ 111 km)
    const latDelta = radiusKm / 111.0;
    const lngDelta = radiusKm / (111.0 * Math.cos(lat * Math.PI / 180));

    const minLat = lat - latDelta;
    const maxLat = lat + latDelta;
    const minLng = lng - lngDelta;
    const maxLng = lng + lngDelta;

    const candidates = await db.all(
      `SELECT p.*, u.last_active_at, u.subscription_status, u.premium_badge_enabled, u.plan_expiry_date
       FROM pets p
       JOIN users u ON p.user_id = u.id
       WHERE p.latitude IS NOT NULL AND p.longitude IS NOT NULL
         AND p.is_flagged = 0
         AND p.latitude BETWEEN ? AND ?
         AND p.longitude BETWEEN ? AND ?`,
      [minLat, maxLat, minLng, maxLng]
    );

    // Step 2: Exact haversine filter + sort
    const excludeSet = new Set(excludeIds);
    const filtered = candidates
      .filter(p => !excludeSet.has(p.id))
      .map(p => ({
        ...p,
        is_premium: !!(hasCurrentAccess(p) && p.premium_badge_enabled),
        distance: haversine(lat, lng, p.latitude, p.longitude),
      }))
      .filter(p => p.distance <= radiusKm)
      .sort((a, b) => {
        const distDiff = a.distance - b.distance;
        if (Math.abs(distDiff) > 0.05) return distDiff;
        const now = Date.now();
        const fiveMinsMs = 5 * 60 * 1000;
        const aActiveTime = a.last_active_at ? new Date(a.last_active_at).getTime() : 0;
        const bActiveTime = b.last_active_at ? new Date(b.last_active_at).getTime() : 0;
        const aOnline = (now - aActiveTime) < fiveMinsMs;
        const bOnline = (now - bActiveTime) < fiveMinsMs;
        if (aOnline !== bOnline) return aOnline ? -1 : 1;
        return bActiveTime - aActiveTime;
      });

    const offset = (page - 1) * limit;
    return filtered.slice(offset, offset + limit);
  }

  /**
   * For chat search nearby — no swipe exclusions, used for "Nearby Pets" section.
   */
  async findNearbyAll(lat, lng, radiusKm, excludePetId, limit = 20) {
    const latDelta = radiusKm / 111.0;
    const lngDelta = radiusKm / (111.0 * Math.cos(lat * Math.PI / 180));

    const candidates = await db.all(
      `SELECT * FROM pets
       WHERE latitude IS NOT NULL AND longitude IS NOT NULL
         AND is_flagged = 0
         AND id != ?
         AND latitude BETWEEN ? AND ?
         AND longitude BETWEEN ? AND ?`,
      [excludePetId, lat - latDelta, lat + latDelta, lng - lngDelta, lng + lngDelta]
    );

    return candidates
      .map(p => ({ ...p, distance: haversine(lat, lng, p.latitude, p.longitude) }))
      .filter(p => p.distance <= radiusKm)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limit);
  }

  /**
   * Search pets by name or pet_username (case-insensitive).
   */
  async searchByQuery(query, excludePetId = null) {
    const q = `%${query.toLowerCase()}%`;
    const sql = excludePetId
      ? `SELECT p.*, u.username as owner_username, u.full_name as owner_full_name
         FROM pets p
         JOIN users u ON p.user_id = u.id
         WHERE p.id != ? AND p.is_flagged = 0 AND (LOWER(p.name) LIKE ? OR LOWER(p.pet_username) LIKE ? OR LOWER(u.username) LIKE ? OR LOWER(u.full_name) LIKE ?)
         LIMIT 20`
      : `SELECT p.*, u.username as owner_username, u.full_name as owner_full_name
         FROM pets p
         JOIN users u ON p.user_id = u.id
         WHERE p.is_flagged = 0 AND (LOWER(p.name) LIKE ? OR LOWER(p.pet_username) LIKE ? OR LOWER(u.username) LIKE ? OR LOWER(u.full_name) LIKE ?)
         LIMIT 20`;
    const params = excludePetId ? [excludePetId, q, q, q, q] : [q, q, q, q];
    return db.all(sql, params);
  }

  async getProfileWithStats(petId) {
    const pet = await db.get(`
      SELECT p.*,
        (SELECT COUNT(*) FROM likes l JOIN posts po ON l.post_id = po.id WHERE po.pet_id = p.id) as total_likes,
        (SELECT COUNT(*) FROM matches WHERE pet1_id = p.id OR pet2_id = p.id) as match_count,
        (SELECT COUNT(*) FROM posts WHERE pet_id = p.id) as post_count
      FROM pets p WHERE p.id = ?
    `, [petId]);
    if (!pet) return null;

    return this.attachCompletionStats(pet);
  }

  // Same shape as getProfileWithStats, keyed by pet_username instead of id
  // -- backs the app.sniffrweb.com/kitty top-level profile URL (see
  // routes/profile.js's GET /:id, which branches here for a non-numeric
  // segment). pet_username is always stored with a leading "@" (see
  // utils/petUsername.js); accepts the value with or without one so a
  // caller doesn't have to know that storage detail.
  async getProfileWithStatsByUsername(username) {
    const handle = `@${String(username).replace(/^@+/, '')}`;
    const pet = await db.get(`
      SELECT p.*,
        (SELECT COUNT(*) FROM likes l JOIN posts po ON l.post_id = po.id WHERE po.pet_id = p.id) as total_likes,
        (SELECT COUNT(*) FROM matches WHERE pet1_id = p.id OR pet2_id = p.id) as match_count,
        (SELECT COUNT(*) FROM posts WHERE pet_id = p.id) as post_count
      FROM pets p WHERE p.pet_username = ?
    `, [handle]);
    if (!pet) return null;

    return this.attachCompletionStats(pet);
  }

  async updatePawsitiveScore(petId, score) {
    const clamped = Math.max(0, Math.min(100, parseInt(score)));
    await db.run('UPDATE pets SET pawsitive_score = ? WHERE id = ?', [clamped, petId]);
    return this.findById(petId);
  }
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth radius km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

export default new PetRepository();