import { Router } from 'express';
import { authenticateAccess } from '../middleware/auth.js';
import { rateLimiter } from '../middleware/rateLimiter.js';
import config from '../config.js';
import SpotlightRepo from '../models/SpotlightRepository.js';
import PetRepo from '../models/PetRepository.js';
import { checkAndNotifyAchievement } from '../services/spotlightAchievements.js';
import { sendServerError } from '../utils/errors.js';

const router = Router();
router.use(authenticateAccess);
router.use(rateLimiter(config.RATE_LIMIT.GET));

router.get('/', async (req, res) => {
  try {
    const area = req.query.area || 'city';

    // Honest fallback chain: real query params (live GPS from the client) >
    // the requesting user's own saved pet location (real data) > explicit
    // NO_LOCATION -- never a hardcoded coordinate that implies location
    // data which doesn't actually exist. isNaN checks (not `||`) because a
    // real lat of 0 (the equator) is falsy and would otherwise be
    // incorrectly treated as "not provided".
    const queryLat = parseFloat(req.query.lat);
    const queryLng = parseFloat(req.query.lng);
    let lat = !isNaN(queryLat) ? queryLat : null;
    let lng = !isNaN(queryLng) ? queryLng : null;

    if (lat == null || lng == null) {
      const myPet = await PetRepo.findByUserId(req.user.id);
      if (myPet?.latitude && myPet?.longitude) {
        lat = myPet.latitude;
        lng = myPet.longitude;
      }
    }

    if (lat == null || lng == null) {
      return res.json({
        error: 'NO_LOCATION',
        top3: [], ranks4To10: [], ranks11To20: [], risingStars: [],
        nextResetTime: null, lastUpdated: null,
      });
    }

    const result = await SpotlightRepo.getTopPets(area, lat, lng);

    // Safety-net check: usually the proactive check triggered by a like
    // (see posts.js) will already have fired by the time anyone visits
    // this page, but this stays as a fallback for any rank change that
    // wasn't caught elsewhere. The atomic claim logic in
    // checkAndNotifyAchievement means this can never create a duplicate
    // even if both paths happen to fire close together.
    const io = req.app.get('io');
    const allRanked = [
      ...(result.top3 || []),
      ...(result.ranks4To10 || []),
      ...(result.ranks11To20 || []),
      ...(result.risingStars || []),
    ];
    checkAndNotifyAchievement(io, req.user.id, area, allRanked).catch(() => {});

    res.json(result);
  } catch (err) {
    sendServerError(res, err);
  }
});

router.get('/history', async (req, res) => {
  try {
    const area = req.query.area || 'city';
    const result = await SpotlightRepo.getHistory(area);
    res.json({ history: result });
  } catch (err) {
    sendServerError(res, err);
  }
});

export default router;