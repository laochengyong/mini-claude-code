import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { SKILLS_DIR } from "../core/config.js";

// Skills are directories with a SKILL.md. Frontmatter holds name/description;
// the body is the actual instructions, loaded on demand via load_skill.

interface SkillEntry {
  name: string;
  description: string;
  content: string;
}

export const skillRegistry = new Map<string, SkillEntry>();

function parseFrontmatter(text: string): { meta: Record<string, any>; body: string } {
  if (!text.startsWith("---")) return { meta: {}, body: text };
  const parts = text.split("---", 3);
  if (parts.length < 3) return { meta: {}, body: text };
  let meta: Record<string, any> = {};
  try {
    meta = parseYaml(parts[1]) || {};
  } catch {
    meta = {};
  }
  return { meta, body: parts[2].trim() };
}

export function scanSkills(): void {
  skillRegistry.clear();
  if (!fs.existsSync(SKILLS_DIR)) return;
  for (const dir of fs.readdirSync(SKILLS_DIR).sort()) {
    const manifest = path.join(SKILLS_DIR, dir, "SKILL.md");
    if (!fs.statSync(path.join(SKILLS_DIR, dir)).isDirectory()) continue;
    if (!fs.existsSync(manifest)) continue;
    const raw = fs.readFileSync(manifest, "utf8");
    const { meta } = parseFrontmatter(raw);
    const name = meta.name ?? dir;
    const desc = meta.description ?? raw.split("\n")[0].replace(/^#+\s*/, "").trim();
    skillRegistry.set(name, { name, description: desc, content: raw });
  }
}

export function listSkills(): string {
  if (skillRegistry.size === 0) return "(no skills found)";
  return [...skillRegistry.values()]
    .map((s) => `- ${s.name}: ${s.description}`)
    .join("\n");
}

export function loadSkill(name: string): string {
  const skill = skillRegistry.get(name);
  if (!skill) {
    const available = [...skillRegistry.keys()].join(", ") || "(none)";
    return `Skill not found: ${name}. Available: ${available}`;
  }
  return skill.content;
}

scanSkills();
