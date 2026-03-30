// hooks/src/verification-signal.mts
var BASH_BOUNDARY_PATTERNS = [
  // uiRender: browser/screenshot/playwright/puppeteer commands → strong
  // More specific patterns first to avoid early generic matches
  { boundary: "uiRender", pattern: /\bnpx\s+playwright\b/i, label: "playwright-cli", evidenceSource: "browser", signalStrength: "strong" },
  { boundary: "uiRender", pattern: /\bopen\s+https?:/i, label: "open-url", evidenceSource: "browser", signalStrength: "strong" },
  { boundary: "uiRender", pattern: /\b(open|launch|browse|screenshot|puppeteer|playwright|chromium|firefox|webkit)\b/i, label: "browser-tool", evidenceSource: "browser", signalStrength: "strong" },
  // clientRequest: curl, wget, httpie → strong
  { boundary: "clientRequest", pattern: /\b(curl|wget|http|httpie)\b/i, label: "http-client", evidenceSource: "bash", signalStrength: "strong" },
  { boundary: "clientRequest", pattern: /\bfetch\s*\(/i, label: "fetch-call", evidenceSource: "bash", signalStrength: "strong" },
  { boundary: "clientRequest", pattern: /\bnpx\s+undici\b/i, label: "undici-cli", evidenceSource: "bash", signalStrength: "strong" },
  // serverHandler: log tailing, server inspection → strong (Bash observation of server state)
  { boundary: "serverHandler", pattern: /\b(tail|less|cat)\b.*\.(log|out|err)\b/i, label: "log-tail", evidenceSource: "bash", signalStrength: "strong" },
  { boundary: "serverHandler", pattern: /\b(tail\s+-f|journalctl\s+-f)\b/i, label: "log-follow", evidenceSource: "bash", signalStrength: "strong" },
  { boundary: "serverHandler", pattern: /\blog(s)?\s/i, label: "log-command", evidenceSource: "bash", signalStrength: "strong" },
  { boundary: "serverHandler", pattern: /\b(vercel\s+logs|vercel\s+inspect)\b/i, label: "vercel-logs", evidenceSource: "bash", signalStrength: "strong" },
  { boundary: "serverHandler", pattern: /\b(lsof|netstat|ss)\s.*:(3000|3001|4000|5173|8080)\b/i, label: "port-inspect", evidenceSource: "bash", signalStrength: "strong" },
  // environment: env reads, config inspection → strong (Bash env observation)
  { boundary: "environment", pattern: /\b(printenv|env\b|echo\s+\$)/i, label: "env-read", evidenceSource: "bash", signalStrength: "strong" },
  { boundary: "environment", pattern: /\bvercel\s+env\b/i, label: "vercel-env", evidenceSource: "bash", signalStrength: "strong" },
  { boundary: "environment", pattern: /\bcat\b.*\.env\b/i, label: "dotenv-read", evidenceSource: "bash", signalStrength: "strong" },
  { boundary: "environment", pattern: /\bnode\s+-e\b.*process\.env\b/i, label: "node-env", evidenceSource: "bash", signalStrength: "strong" }
];
var BROWSER_TOOLS = /* @__PURE__ */ new Set([
  "agent_browser",
  "agent-browser",
  "mcp__browser__navigate",
  "mcp__browser__screenshot",
  "mcp__browser__click",
  "mcp__puppeteer__navigate",
  "mcp__puppeteer__screenshot",
  "mcp__playwright__navigate",
  "mcp__playwright__screenshot"
]);
var HTTP_TOOLS = /* @__PURE__ */ new Set([
  "WebFetch",
  "mcp__fetch__fetch",
  "mcp__http__request",
  "mcp__http__get",
  "mcp__http__post"
]);
var URL_ROUTE_REGEX = /https?:\/\/[^/\s]+(\/([\w-]+(?:\/[\w-]+)*))/;
function inferRouteFromUrl(url) {
  const match = URL_ROUTE_REGEX.exec(url);
  return match?.[1] ?? null;
}
var FILE_ROUTE_REGEX = /\b(?:app|pages|src\/pages|src\/app)\/([\w[\].-]+(?:\/[\w[\].-]+)*)/;
function inferRouteFromFilePath(filePath) {
  const match = FILE_ROUTE_REGEX.exec(filePath);
  if (!match) return null;
  const route = "/" + match[1].replace(/\/page\.\w+$/, "").replace(/\/route\.\w+$/, "").replace(/\/layout\.\w+$/, "").replace(/\/loading\.\w+$/, "").replace(/\/error\.\w+$/, "").replace(/\[([^\]]+)\]/g, ":$1");
  return route === "/" ? "/" : route.replace(/\/$/, "");
}
function classifyVerificationSignal(input) {
  const { toolName, toolInput } = input;
  if (toolName === "Bash") {
    const command = String(toolInput.command || "");
    if (!command) return null;
    for (const bp of BASH_BOUNDARY_PATTERNS) {
      if (bp.pattern.test(command)) {
        const inferredRoute = inferRouteFromUrl(command);
        return {
          boundary: bp.boundary,
          matchedPattern: bp.label,
          inferredRoute,
          signalStrength: bp.signalStrength,
          evidenceSource: bp.evidenceSource,
          summary: command.slice(0, 200),
          toolName: "Bash"
        };
      }
    }
    return null;
  }
  if (BROWSER_TOOLS.has(toolName)) {
    const url = String(toolInput.url || toolInput.uri || "");
    return {
      boundary: "uiRender",
      matchedPattern: "browser-tool",
      inferredRoute: url ? inferRouteFromUrl(url) : null,
      signalStrength: "strong",
      evidenceSource: "browser",
      summary: url ? url.slice(0, 200) : toolName,
      toolName
    };
  }
  if (HTTP_TOOLS.has(toolName)) {
    const url = String(toolInput.url || toolInput.uri || "");
    if (!url && toolName !== "WebFetch") {
      return {
        boundary: "clientRequest",
        matchedPattern: "http-tool",
        inferredRoute: null,
        signalStrength: "strong",
        evidenceSource: "http",
        summary: toolName,
        toolName
      };
    }
    if (!url) return null;
    return {
      boundary: "clientRequest",
      matchedPattern: toolName === "WebFetch" ? "web-fetch" : "http-tool",
      inferredRoute: inferRouteFromUrl(url),
      signalStrength: "strong",
      evidenceSource: "http",
      summary: url.slice(0, 200),
      toolName
    };
  }
  if (toolName === "Read") {
    const filePath = String(toolInput.file_path || "");
    if (!filePath) return null;
    if (/\.env(\.\w+)?$/.test(filePath)) {
      return {
        boundary: "environment",
        matchedPattern: "env-file-read",
        inferredRoute: null,
        signalStrength: "soft",
        evidenceSource: "env-read",
        summary: filePath,
        toolName: "Read"
      };
    }
    if (/vercel\.json$/.test(filePath) || /\.vercel\/project\.json$/.test(filePath)) {
      return {
        boundary: "environment",
        matchedPattern: "vercel-config-read",
        inferredRoute: null,
        signalStrength: "soft",
        evidenceSource: "env-read",
        summary: filePath,
        toolName: "Read"
      };
    }
    if (/\.(log|out|err)$/.test(filePath) || /vercel-logs/.test(filePath) || /\.next\/.*server.*\.log/.test(filePath)) {
      return {
        boundary: "serverHandler",
        matchedPattern: "log-file-read",
        inferredRoute: inferRouteFromFilePath(filePath),
        signalStrength: "soft",
        evidenceSource: "log-read",
        summary: filePath,
        toolName: "Read"
      };
    }
    return null;
  }
  if (toolName === "Grep") {
    const path = String(toolInput.path || "");
    if (/\.(log|out|err)$/.test(path) || /logs?\//.test(path)) {
      return {
        boundary: "serverHandler",
        matchedPattern: "log-grep",
        inferredRoute: null,
        signalStrength: "soft",
        evidenceSource: "log-read",
        summary: `grep ${toolInput.pattern || ""} in ${path}`.slice(0, 200),
        toolName: "Grep"
      };
    }
    if (/\.env/.test(path)) {
      return {
        boundary: "environment",
        matchedPattern: "env-grep",
        inferredRoute: null,
        signalStrength: "soft",
        evidenceSource: "env-read",
        summary: `grep ${toolInput.pattern || ""} in ${path}`.slice(0, 200),
        toolName: "Grep"
      };
    }
    return null;
  }
  if (toolName === "Glob") {
    const pattern = String(toolInput.pattern || "");
    if (/\*\.(log|out|err)/.test(pattern) || /logs?\//.test(pattern)) {
      return {
        boundary: "serverHandler",
        matchedPattern: "log-glob",
        inferredRoute: null,
        signalStrength: "soft",
        evidenceSource: "log-read",
        summary: `glob ${pattern}`.slice(0, 200),
        toolName: "Glob"
      };
    }
    if (/\.env/.test(pattern)) {
      return {
        boundary: "environment",
        matchedPattern: "env-glob",
        inferredRoute: null,
        signalStrength: "soft",
        evidenceSource: "env-read",
        summary: `glob ${pattern}`.slice(0, 200),
        toolName: "Glob"
      };
    }
    return null;
  }
  if (toolName === "Edit" || toolName === "Write") {
    return null;
  }
  return null;
}
export {
  classifyVerificationSignal
};
