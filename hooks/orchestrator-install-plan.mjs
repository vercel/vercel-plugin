// hooks/src/orchestrator-install-plan.mts
function uniqueSorted(values) {
  return [...new Set(values.filter((value) => value.trim() !== ""))].sort();
}
function formatReasonList(detection) {
  return detection.reasons.map((reason) => `${reason.kind}:${reason.source}`).join(", ");
}
function buildSkillInstallPlan(args) {
  const likelySkills = uniqueSorted(
    args.detections.map((d) => d.skill)
  );
  const installedSkills = uniqueSorted(args.installedSkills);
  const installedSet = new Set(installedSkills);
  const missingSkills = likelySkills.filter(
    (skill) => !installedSet.has(skill)
  );
  const installCommand = missingSkills.length === 0 ? null : `npx skills install ${missingSkills.join(" ")} --dir .skills`;
  return {
    schemaVersion: 1,
    createdAt: (args.now ? args.now() : /* @__PURE__ */ new Date()).toISOString(),
    projectRoot: args.projectRoot,
    likelySkills,
    installedSkills,
    missingSkills,
    bundledFallbackEnabled: args.bundledFallbackEnabled,
    detections: [...args.detections].sort(
      (a, b) => a.skill.localeCompare(b.skill)
    ),
    actions: [
      {
        id: "install-missing",
        label: "Install detected skills",
        description: missingSkills.length === 0 ? "All detected skills are already cached." : `Install ${missingSkills.length} missing skill${missingSkills.length === 1 ? "" : "s"} into .skills/.`,
        command: installCommand,
        default: true
      },
      {
        id: "explain",
        label: "Explain detections",
        description: "Open the persisted install plan with full detection reasons.",
        command: "cat .skills/install-plan.json"
      },
      {
        id: "offline",
        label: "Work offline from cache",
        description: args.bundledFallbackEnabled ? "Disable bundled fallback and rely on cached skills only." : "Bundled fallback is already disabled.",
        command: "export VERCEL_PLUGIN_DISABLE_BUNDLED_FALLBACK=1"
      }
    ]
  };
}
function serializeSkillInstallPlan(plan) {
  return JSON.stringify(plan);
}
function formatSkillInstallPalette(plan) {
  if (plan.likelySkills.length === 0) return null;
  const lines = [
    "### Vercel skill orchestrator",
    `- Detected: ${plan.likelySkills.join(", ")}`,
    `- Cached: ${plan.installedSkills.length > 0 ? plan.installedSkills.join(", ") : "none"}`,
    `- Missing: ${plan.missingSkills.length > 0 ? plan.missingSkills.join(", ") : "none"}`
  ];
  const installAction = plan.actions.find(
    (action) => action.id === "install-missing"
  );
  if (installAction?.command) {
    lines.push(`- [1] Install now: ${installAction.command}`);
  }
  lines.push("- [2] Explain: cat .skills/install-plan.json");
  lines.push(
    "- [3] Offline cache only: export VERCEL_PLUGIN_DISABLE_BUNDLED_FALLBACK=1"
  );
  if (plan.detections.length > 0) {
    lines.push("", "Detection reasons:");
    for (const detection of plan.detections) {
      lines.push(`- ${detection.skill}: ${formatReasonList(detection)}`);
    }
  }
  return lines.join("\n");
}
export {
  buildSkillInstallPlan,
  formatSkillInstallPalette,
  serializeSkillInstallPlan
};
