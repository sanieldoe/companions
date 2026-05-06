import { Router } from "express";
import { getPersonaName, getPersonas } from "./config.js";

export const MODES = ["mentor", "shapeshifter", "keeper", "tracker"] as const;
export type Mode = (typeof MODES)[number];

export const MODE_META: Record<Mode, { id: Mode; name: string; accent: string; mascot: string }> = {
  mentor:       { id: "mentor",       name: getPersonaName("mentor"),       accent: "#4CAF50", mascot: "frog" },
  shapeshifter: { id: "shapeshifter", name: getPersonaName("shapeshifter"), accent: "#FF6135", mascot: "fox" },
  keeper:       { id: "keeper",       name: getPersonaName("keeper"),       accent: "#FFD54F", mascot: "bee" },
  tracker:      { id: "tracker",      name: getPersonaName("tracker"),      accent: "#42A5F5", mascot: "bird" },
};

export function createRouter(): Router {
  const router = Router();

  router.get("/modes", (_req, res) => {
    res.json({ modes: Object.values(MODE_META) });
  });

  router.get("/personas", (_req, res) => {
    res.json({ personas: getPersonas() });
  });

  return router;
}
