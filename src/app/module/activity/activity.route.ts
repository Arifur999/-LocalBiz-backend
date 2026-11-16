import { Router } from "express";
import { checkAuth } from "../../middleware/checkAuth.js";
import { checkSubscription } from "../../middleware/checkSubscription.js";
import { ActivityController } from "./activity.controller.js";

const router = Router();

// Open to anyone in the workspace, but the service drops every source whose own
// list route the caller could not open (activityAccess.ts), so the feed never
// shows more than the pages it draws from. Every query is scoped to owner_id.
router.get("/day", checkAuth(), checkSubscription, ActivityController.getDayActivity);

export const ActivityRoutes = router;
