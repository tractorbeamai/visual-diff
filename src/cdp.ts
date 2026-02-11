/**
 * CDP (Chrome DevTools Protocol) WebSocket proxy.
 * Ported from Moltworker (https://github.com/cloudflare/moltworker/blob/main/src/routes/cdp.ts).
 *
 * Translates CDP commands from agent-browser into Puppeteer calls against
 * the Cloudflare Browser Rendering binding.
 *
 * Supported CDP domains:
 * - Browser: getVersion, close
 * - Target: createTarget, closeTarget, getTargets, attachToTarget
 * - Page: navigate, reload, captureScreenshot, getFrameTree, getLayoutMetrics,
 *         bringToFront, setContent, addScriptToEvaluateOnNewDocument, stopLoading, setBypassCSP
 * - Runtime: evaluate, callFunctionOn, getProperties, releaseObject, releaseObjectGroup
 * - DOM: getDocument, querySelector, querySelectorAll, getOuterHTML, getAttributes,
 *        setAttributeValue, focus, getBoxModel, scrollIntoViewIfNeeded, removeNode, setFileInputFiles
 * - Input: dispatchMouseEvent, dispatchKeyEvent, insertText
 * - Network: enable, disable, setCacheDisabled, setExtraHTTPHeaders, setCookie, getCookies, deleteCookies
 * - Emulation: setDeviceMetricsOverride, clearDeviceMetricsOverride, setUserAgentOverride
 * - Fetch: enable, disable, continueRequest, fulfillRequest, failRequest
 */
import puppeteer, { type Browser, type Page, type KeyInput } from "@cloudflare/puppeteer";
import type { Env } from "./types";

// ─── Types ───────────────────────────────────────────────────────────────────

interface CDPRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface CDPSession {
  browser: Browser;
  pages: Map<string, Page>;
  defaultTargetId: string;
  nodeIdCounter: number;
  nodeMap: Map<number, string>;
  objectIdCounter: number;
  objectMap: Map<string, unknown>;
  scriptsToEvaluateOnNewDocument: Map<string, string>;
  extraHTTPHeaders: Map<string, string>;
}

// ─── Public handler ──────────────────────────────────────────────────────────

export async function handleCDP(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);

  // Discovery endpoints
  if (url.pathname === "/cdp/json/version") {
    return handleJsonVersion(url, env);
  }
  if (
    url.pathname === "/cdp/json/list" ||
    url.pathname === "/cdp/json"
  ) {
    return handleJsonList(url, env);
  }

  // WebSocket upgrade
  const upgradeHeader = request.headers.get("Upgrade");
  if (upgradeHeader?.toLowerCase() !== "websocket") {
    return Response.json(
      { error: "WebSocket upgrade required", hint: "Connect via ws://host/cdp?secret=<secret>" },
      { status: 426 },
    );
  }

  if (!verifySecret(url, env)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const webSocketPair = new WebSocketPair();
  const [client, server] = Object.values(webSocketPair);

  server.accept();
  initCDPSession(server, env).catch((err) => {
    console.error("[CDP] Failed to initialize session:", err);
    server.close(1011, "Failed to initialize browser session");
  });

  return new Response(null, { status: 101, webSocket: client });
}

// ─── Discovery endpoints ─────────────────────────────────────────────────────

function handleJsonVersion(url: URL, env: Env): Response {
  if (!verifySecret(url, env)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const wsProtocol = url.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${wsProtocol}//${url.host}/cdp?secret=${encodeURIComponent(url.searchParams.get("secret")!)}`;
  return Response.json({
    Browser: "Cloudflare-Browser-Rendering/1.0",
    "Protocol-Version": "1.3",
    "User-Agent": "Mozilla/5.0 Cloudflare Browser Rendering",
    "V8-Version": "cloudflare",
    "WebKit-Version": "cloudflare",
    webSocketDebuggerUrl: wsUrl,
  });
}

function handleJsonList(url: URL, env: Env): Response {
  if (!verifySecret(url, env)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const wsProtocol = url.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${wsProtocol}//${url.host}/cdp?secret=${encodeURIComponent(url.searchParams.get("secret")!)}`;
  return Response.json([
    {
      description: "",
      devtoolsFrontendUrl: "",
      id: "cloudflare-browser",
      title: "Cloudflare Browser Rendering",
      type: "page",
      url: "about:blank",
      webSocketDebuggerUrl: wsUrl,
    },
  ]);
}

// ─── Session init ────────────────────────────────────────────────────────────

async function initCDPSession(ws: WebSocket, env: Env): Promise<void> {
  let session: CDPSession | null = null;

  try {
    const browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();
    const targetId = crypto.randomUUID();

    session = {
      browser,
      pages: new Map([[targetId, page]]),
      defaultTargetId: targetId,
      nodeIdCounter: 1,
      nodeMap: new Map(),
      objectIdCounter: 1,
      objectMap: new Map(),
      scriptsToEvaluateOnNewDocument: new Map(),
      extraHTTPHeaders: new Map(),
    };

    sendEvent(ws, "Target.targetCreated", {
      targetInfo: { targetId, type: "page", title: "", url: "about:blank", attached: true },
    });

    console.log("[CDP] Session initialized, targetId:", targetId);
  } catch (err) {
    console.error("[CDP] Browser launch failed:", err);
    ws.close(1011, "Browser launch failed");
    return;
  }

  ws.addEventListener("message", async (event) => {
    if (!session) return;
    let request: CDPRequest;
    try {
      request = JSON.parse(event.data as string);
    } catch {
      console.error("[CDP] Invalid JSON received");
      return;
    }

    try {
      const result = await handleCDPMethod(session, request.method, request.params ?? {}, ws);
      sendResponse(ws, request.id, result);
    } catch (err) {
      console.error("[CDP] Method error:", request.method, err);
      sendError(ws, request.id, -32000, err instanceof Error ? err.message : "Unknown error");
    }
  });

  ws.addEventListener("close", async () => {
    console.log("[CDP] WebSocket closed, cleaning up");
    if (session) {
      try { await session.browser.close(); } catch { /* noop */ }
    }
  });

  ws.addEventListener("error", (event) => {
    console.error("[CDP] WebSocket error:", event);
  });
}

// ─── Method dispatch ─────────────────────────────────────────────────────────

async function handleCDPMethod(
  session: CDPSession,
  method: string,
  params: Record<string, unknown>,
  ws: WebSocket,
): Promise<unknown> {
  const [domain, command] = method.split(".");
  const targetId = (params.targetId as string) || session.defaultTargetId;
  const page = session.pages.get(targetId);

  switch (domain) {
    case "Browser":
      return handleBrowser(session, command);
    case "Target":
      return handleTarget(session, command, params, ws);
    case "Page":
      if (!page) throw new Error(`Target not found: ${targetId}`);
      return handlePage(session, page, command, params, ws);
    case "Runtime":
      if (!page) throw new Error(`Target not found: ${targetId}`);
      return handleRuntime(session, page, command, params);
    case "DOM":
      if (!page) throw new Error(`Target not found: ${targetId}`);
      return handleDOM(session, page, command, params);
    case "Input":
      if (!page) throw new Error(`Target not found: ${targetId}`);
      return handleInput(page, command, params);
    case "Network":
      return handleNetwork(session, page, command, params);
    case "Emulation":
      if (!page) throw new Error(`Target not found: ${targetId}`);
      return handleEmulation(page, command, params);
    case "Fetch":
      if (!page) throw new Error(`Target not found: ${targetId}`);
      return handleFetch(session, page, command, params, ws);
    default:
      throw new Error(`Unknown domain: ${domain}`);
  }
}

// ─── Browser domain ──────────────────────────────────────────────────────────

async function handleBrowser(session: CDPSession, command: string): Promise<unknown> {
  switch (command) {
    case "getVersion":
      return {
        protocolVersion: "1.3",
        product: "Cloudflare-Browser-Rendering",
        revision: "cloudflare",
        userAgent: "Mozilla/5.0 Cloudflare Browser Rendering",
        jsVersion: "V8",
      };
    case "close":
      await session.browser.close();
      return {};
    default:
      throw new Error(`Unknown Browser method: ${command}`);
  }
}

// ─── Target domain ───────────────────────────────────────────────────────────

async function handleTarget(
  session: CDPSession,
  command: string,
  params: Record<string, unknown>,
  ws: WebSocket,
): Promise<unknown> {
  switch (command) {
    case "createTarget": {
      const url = (params.url as string) || "about:blank";
      const page = await session.browser.newPage();
      const targetId = crypto.randomUUID();
      session.pages.set(targetId, page);

      if (url !== "about:blank") {
        await page.goto(url);
      }

      sendEvent(ws, "Target.targetCreated", {
        targetInfo: {
          targetId,
          type: "page",
          title: await page.title(),
          url: page.url(),
          attached: true,
        },
      });
      return { targetId };
    }

    case "closeTarget": {
      const tid = params.targetId as string;
      const p = session.pages.get(tid);
      if (!p) throw new Error(`Target not found: ${tid}`);
      await p.close();
      session.pages.delete(tid);
      sendEvent(ws, "Target.targetDestroyed", { targetId: tid });
      return { success: true };
    }

    case "getTargets": {
      const targets = [];
      for (const [tid, p] of session.pages) {
        targets.push({
          targetId: tid,
          type: "page",
          title: await p.title(),
          url: p.url(),
          attached: true,
        });
      }
      return { targetInfos: targets };
    }

    case "attachToTarget":
      return { sessionId: params.targetId };

    default:
      throw new Error(`Unknown Target method: ${command}`);
  }
}

// ─── Page domain ─────────────────────────────────────────────────────────────

async function handlePage(
  session: CDPSession,
  page: Page,
  command: string,
  params: Record<string, unknown>,
  ws: WebSocket,
): Promise<unknown> {
  switch (command) {
    case "navigate": {
      const url = params.url as string;
      if (!url) throw new Error("url is required");

      const response = await page.goto(url, { waitUntil: "load" });

      sendEvent(ws, "Page.frameNavigated", {
        frame: {
          id: session.defaultTargetId,
          url: page.url(),
          securityOrigin: new URL(page.url()).origin,
          mimeType: "text/html",
        },
      });
      sendEvent(ws, "Page.loadEventFired", { timestamp: Date.now() / 1000 });

      return {
        frameId: session.defaultTargetId,
        loaderId: crypto.randomUUID(),
        errorText: response?.ok() ? undefined : "Navigation failed",
      };
    }

    case "reload":
      await page.reload();
      return {};

    case "getFrameTree":
      return {
        frameTree: {
          frame: {
            id: session.defaultTargetId,
            loaderId: crypto.randomUUID(),
            url: page.url(),
            securityOrigin: page.url() ? new URL(page.url()).origin : "",
            mimeType: "text/html",
          },
          childFrames: [],
        },
      };

    case "captureScreenshot": {
      const format = (params.format as string) || "png";
      const quality = params.quality as number | undefined;
      const clip = params.clip as { x: number; y: number; width: number; height: number } | undefined;

      const data = await page.screenshot({
        type: format as "png" | "jpeg" | "webp",
        encoding: "base64",
        quality: format === "jpeg" ? quality : undefined,
        clip,
        fullPage: params.fullPage as boolean | undefined,
      });

      return { data };
    }

    case "getLayoutMetrics": {
      const metrics = await page.evaluate(() => ({
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
        clientWidth: document.documentElement.clientWidth,
        clientHeight: document.documentElement.clientHeight,
      }));
      return {
        layoutViewport: { pageX: 0, pageY: 0, clientWidth: metrics.clientWidth, clientHeight: metrics.clientHeight },
        visualViewport: { offsetX: 0, offsetY: 0, pageX: 0, pageY: 0, clientWidth: metrics.clientWidth, clientHeight: metrics.clientHeight, scale: 1 },
        contentSize: { x: 0, y: 0, width: metrics.width, height: metrics.height },
      };
    }

    case "bringToFront":
      await page.bringToFront();
      return {};

    case "setContent": {
      const html = params.html as string;
      if (!html) throw new Error("html is required");
      await page.setContent(html, {
        waitUntil: (params.waitUntil as "load" | "domcontentloaded" | "networkidle0" | "networkidle2") || "load",
      });
      return {};
    }

    case "addScriptToEvaluateOnNewDocument": {
      const source = params.source as string;
      if (!source) throw new Error("source is required");
      const identifier = crypto.randomUUID();
      session.scriptsToEvaluateOnNewDocument.set(identifier, source);
      await page.evaluateOnNewDocument(source);
      return { identifier };
    }

    case "removeScriptToEvaluateOnNewDocument": {
      session.scriptsToEvaluateOnNewDocument.delete(params.identifier as string);
      return {};
    }

    case "stopLoading":
      await page.evaluate(() => window.stop());
      return {};

    case "getNavigationHistory": {
      return page.evaluate(() => ({
        currentIndex: window.history.length - 1,
        entries: [{
          id: 0,
          url: window.location.href,
          userTypedURL: window.location.href,
          title: document.title,
          transitionType: "typed",
        }],
      }));
    }

    case "navigateToHistoryEntry": {
      const entryId = params.entryId as number;
      await page.evaluate((id: number) => window.history.go(id - (window.history.length - 1)), entryId);
      return {};
    }

    case "setBypassCSP":
      await page.setBypassCSP(params.enabled as boolean);
      return {};

    case "handleJavaScriptDialog": {
      const accept = params.accept as boolean;
      const promptText = params.promptText as string | undefined;
      page.on("dialog", async (dialog) => {
        if (accept) await dialog.accept(promptText);
        else await dialog.dismiss();
      });
      return {};
    }

    case "enable":
    case "disable":
      return {};

    default:
      throw new Error(`Unknown Page method: ${command}`);
  }
}

// ─── Runtime domain ──────────────────────────────────────────────────────────

async function handleRuntime(
  session: CDPSession,
  page: Page,
  command: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (command) {
    case "evaluate": {
      const expression = params.expression as string;
      if (!expression) throw new Error("expression is required");
      const returnByValue = (params.returnByValue as boolean) ?? true;
      const awaitPromise = (params.awaitPromise as boolean) ?? false;

      try {
        const wrapped = awaitPromise ? `(async () => { return ${expression}; })()` : expression;
        const result = await page.evaluate(wrapped);

        let objectId: string | undefined;
        if (!returnByValue && result !== null && typeof result === "object") {
          objectId = `obj-${session.objectIdCounter++}`;
          session.objectMap.set(objectId, result);
        }

        return {
          result: {
            type: typeof result,
            subtype: Array.isArray(result) ? "array" : result === null ? "null" : undefined,
            className: result?.constructor?.name,
            value: returnByValue ? result : undefined,
            objectId,
            description: String(result),
          },
        };
      } catch (err) {
        return {
          exceptionDetails: {
            exceptionId: 1,
            text: err instanceof Error ? err.message : "Evaluation failed",
            lineNumber: 0,
            columnNumber: 0,
          },
        };
      }
    }

    case "callFunctionOn": {
      const functionDeclaration = params.functionDeclaration as string;
      const args = (params.arguments as Array<{ value?: unknown; objectId?: string }>) || [];
      const returnByValue = (params.returnByValue as boolean) ?? true;

      try {
        const argValues = args.map((a) => (a.objectId ? session.objectMap.get(a.objectId) : a.value));
        const fn = new Function(`return (${functionDeclaration}).apply(this, arguments)`);
        const result = await page.evaluate(fn as () => unknown, ...argValues);

        let objectId: string | undefined;
        if (!returnByValue && result !== null && typeof result === "object") {
          objectId = `obj-${session.objectIdCounter++}`;
          session.objectMap.set(objectId, result);
        }

        return {
          result: {
            type: typeof result,
            subtype: Array.isArray(result) ? "array" : result === null ? "null" : undefined,
            value: returnByValue ? result : undefined,
            objectId,
          },
        };
      } catch (err) {
        return {
          exceptionDetails: {
            exceptionId: 1,
            text: err instanceof Error ? err.message : "Call failed",
            lineNumber: 0,
            columnNumber: 0,
          },
        };
      }
    }

    case "getProperties": {
      const obj = session.objectMap.get(params.objectId as string);
      if (!obj || typeof obj !== "object") return { result: [] };

      const properties: unknown[] = [];
      const keys = (params.ownProperties as boolean) ?? true
        ? Object.getOwnPropertyNames(obj)
        : Object.keys(obj as Record<string, unknown>);

      for (const key of keys) {
        const value = (obj as Record<string, unknown>)[key];
        const descriptor = Object.getOwnPropertyDescriptor(obj, key);
        properties.push({
          name: key,
          value: { type: typeof value, value, description: String(value) },
          writable: descriptor?.writable,
          configurable: descriptor?.configurable,
          enumerable: descriptor?.enumerable,
          isOwn: true,
        });
      }
      return { result: properties };
    }

    case "releaseObject":
      session.objectMap.delete(params.objectId as string);
      return {};

    case "releaseObjectGroup":
      session.objectMap.clear();
      return {};

    case "enable":
    case "disable":
      return {};

    default:
      throw new Error(`Unknown Runtime method: ${command}`);
  }
}

// ─── DOM domain ──────────────────────────────────────────────────────────────

async function handleDOM(
  session: CDPSession,
  page: Page,
  command: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (command) {
    case "getDocument": {
      const depth = (params.depth as number) ?? 1;
      const doc = await page.evaluate((maxDepth: number) => {
        function serializeNode(node: Node, d: number): unknown {
          const base: Record<string, unknown> = {
            nodeId: Math.floor(Math.random() * 1000000),
            nodeType: node.nodeType,
            nodeName: node.nodeName,
            localName: node.nodeName.toLowerCase(),
            nodeValue: node.nodeValue || "",
          };
          if (node instanceof Element) {
            base.attributes = [];
            for (const attr of node.attributes) {
              (base.attributes as string[]).push(attr.name, attr.value);
            }
            if (d < maxDepth && node.children.length > 0) {
              base.children = [];
              for (const child of node.children) {
                (base.children as unknown[]).push(serializeNode(child, d + 1));
              }
            }
            base.childNodeCount = node.children.length;
          }
          return base;
        }
        return serializeNode(document.documentElement, 0);
      }, depth);

      const rootNodeId = session.nodeIdCounter++;
      session.nodeMap.set(rootNodeId, "html");

      return {
        root: {
          nodeId: rootNodeId,
          backendNodeId: rootNodeId,
          nodeType: 9,
          nodeName: "#document",
          localName: "",
          nodeValue: "",
          childNodeCount: 1,
          children: [doc],
          documentURL: page.url(),
          baseURL: page.url(),
        },
      };
    }

    case "querySelector": {
      const selector = params.selector as string;
      if (!selector) throw new Error("selector is required");
      const element = await page.$(selector);
      if (!element) return { nodeId: 0 };
      const nodeId = session.nodeIdCounter++;
      session.nodeMap.set(nodeId, selector);
      return { nodeId };
    }

    case "querySelectorAll": {
      const selector = params.selector as string;
      if (!selector) throw new Error("selector is required");
      const elements = await page.$$(selector);
      const nodeIds = elements.map((_, i) => {
        const nodeId = session.nodeIdCounter++;
        session.nodeMap.set(nodeId, `${selector}:nth-of-type(${i + 1})`);
        return nodeId;
      });
      return { nodeIds };
    }

    case "getOuterHTML": {
      const nodeId = params.nodeId as number;
      const selector = session.nodeMap.get(nodeId);
      if (!selector) {
        const html = await page.content();
        return { outerHTML: html };
      }
      const html = await page.evaluate((sel: string) => {
        const el = document.querySelector(sel);
        return el ? el.outerHTML : "";
      }, selector);
      return { outerHTML: html };
    }

    case "getAttributes": {
      const nodeId = params.nodeId as number;
      const selector = session.nodeMap.get(nodeId);
      if (!selector) throw new Error(`Node not found: ${nodeId}`);
      const attributes = await page.evaluate((sel: string) => {
        const el = document.querySelector(sel);
        if (!el) return [];
        const attrs: string[] = [];
        for (const attr of el.attributes) attrs.push(attr.name, attr.value);
        return attrs;
      }, selector);
      return { attributes };
    }

    case "setAttributeValue": {
      const selector = session.nodeMap.get(params.nodeId as number);
      if (!selector) throw new Error(`Node not found: ${params.nodeId}`);
      await page.evaluate(
        (sel: string, name: string, value: string) => {
          document.querySelector(sel)?.setAttribute(name, value);
        },
        selector,
        params.name as string,
        params.value as string,
      );
      return {};
    }

    case "focus": {
      const selector = session.nodeMap.get(params.nodeId as number);
      if (!selector) throw new Error(`Node not found: ${params.nodeId}`);
      await page.focus(selector);
      return {};
    }

    case "getBoxModel": {
      const selector = session.nodeMap.get(params.nodeId as number);
      if (!selector) throw new Error(`Node not found: ${params.nodeId}`);
      const box = await page.evaluate((sel: string) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        const scrollX = window.scrollX;
        const scrollY = window.scrollY;
        const style = window.getComputedStyle(el);
        const pT = parseFloat(style.paddingTop), pR = parseFloat(style.paddingRight),
              pB = parseFloat(style.paddingBottom), pL = parseFloat(style.paddingLeft);
        const bT = parseFloat(style.borderTopWidth), bR = parseFloat(style.borderRightWidth),
              bB = parseFloat(style.borderBottomWidth), bL = parseFloat(style.borderLeftWidth);
        const mT = parseFloat(style.marginTop), mR = parseFloat(style.marginRight),
              mB = parseFloat(style.marginBottom), mL = parseFloat(style.marginLeft);

        const toQuad = (b: { x: number; y: number; width: number; height: number }) =>
          [b.x, b.y, b.x + b.width, b.y, b.x + b.width, b.y + b.height, b.x, b.y + b.height];

        const content = {
          x: rect.left + scrollX + bL + pL, y: rect.top + scrollY + bT + pT,
          width: rect.width - bL - bR - pL - pR, height: rect.height - bT - bB - pT - pB,
        };
        const padding = {
          x: rect.left + scrollX + bL, y: rect.top + scrollY + bT,
          width: rect.width - bL - bR, height: rect.height - bT - bB,
        };
        const border = { x: rect.left + scrollX, y: rect.top + scrollY, width: rect.width, height: rect.height };
        const margin = {
          x: rect.left + scrollX - mL, y: rect.top + scrollY - mT,
          width: rect.width + mL + mR, height: rect.height + mT + mB,
        };

        return {
          content: toQuad(content), padding: toQuad(padding),
          border: toQuad(border), margin: toQuad(margin),
          width: Math.round(rect.width), height: Math.round(rect.height),
        };
      }, selector);
      if (!box) throw new Error("Could not compute box model");
      return { model: box };
    }

    case "scrollIntoViewIfNeeded": {
      const selector = session.nodeMap.get(params.nodeId as number);
      if (!selector) throw new Error(`Node not found: ${params.nodeId}`);
      await page.evaluate((sel: string) => {
        document.querySelector(sel)?.scrollIntoView({ block: "center", inline: "center" });
      }, selector);
      return {};
    }

    case "removeNode": {
      const selector = session.nodeMap.get(params.nodeId as number);
      if (!selector) throw new Error(`Node not found: ${params.nodeId}`);
      await page.evaluate((sel: string) => document.querySelector(sel)?.remove(), selector);
      return {};
    }

    case "setNodeValue": {
      const selector = session.nodeMap.get(params.nodeId as number);
      if (!selector) throw new Error(`Node not found: ${params.nodeId}`);
      await page.evaluate(
        (sel: string, val: string) => {
          const el = document.querySelector(sel);
          if (el) el.textContent = val;
        },
        selector,
        params.value as string,
      );
      return {};
    }

    case "setFileInputFiles": {
      const selector = session.nodeMap.get(params.nodeId as number);
      if (!selector) throw new Error(`Node not found: ${params.nodeId}`);
      const element = await page.$(selector);
      if (!element) throw new Error("Element not found");
      const files = params.files as string[];
      await (element as unknown as { uploadFile: (...paths: string[]) => Promise<void> }).uploadFile(...files);
      return {};
    }

    default:
      throw new Error(`Unknown DOM method: ${command}`);
  }
}

// ─── Input domain ────────────────────────────────────────────────────────────

async function handleInput(
  page: Page,
  command: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (command) {
    case "dispatchMouseEvent": {
      const type = params.type as string;
      const x = params.x as number;
      const y = params.y as number;
      const button = (params.button as string) || "left";
      const clickCount = (params.clickCount as number) || 1;

      const puppeteerButton = button === "right" ? "right" : button === "middle" ? "middle" : "left";

      switch (type) {
        case "mousePressed":
          await page.mouse.down({ button: puppeteerButton });
          break;
        case "mouseReleased":
          await page.mouse.up({ button: puppeteerButton });
          break;
        case "mouseMoved":
          await page.mouse.move(x, y);
          break;
        case "mouseWheel":
          await page.mouse.wheel({
            deltaX: (params.deltaX as number) || 0,
            deltaY: (params.deltaY as number) || 0,
          });
          break;
        default:
          if (clickCount === 2) {
            await page.mouse.click(x, y, { button: puppeteerButton, clickCount: 2 });
          } else {
            await page.mouse.click(x, y, { button: puppeteerButton });
          }
      }
      return {};
    }

    case "dispatchKeyEvent": {
      const type = params.type as string;
      const key = params.key as string;

      if (type === "keyDown" || type === "rawKeyDown") {
        await page.keyboard.down(key as KeyInput);
      } else if (type === "keyUp") {
        await page.keyboard.up(key as KeyInput);
      } else if (type === "char") {
        await page.keyboard.sendCharacter(params.text as string || key);
      }
      return {};
    }

    case "insertText":
      await page.keyboard.sendCharacter(params.text as string);
      return {};

    default:
      throw new Error(`Unknown Input method: ${command}`);
  }
}

// ─── Network domain ──────────────────────────────────────────────────────────

async function handleNetwork(
  session: CDPSession,
  page: Page | undefined,
  command: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (command) {
    case "enable":
    case "disable":
      return {};

    case "setCacheDisabled":
      if (page) await page.setCacheEnabled(!(params.cacheDisabled as boolean));
      return {};

    case "setExtraHTTPHeaders": {
      const headers = params.headers as Record<string, string>;
      if (headers) {
        for (const [k, v] of Object.entries(headers)) {
          session.extraHTTPHeaders.set(k, v);
        }
        if (page) {
          await page.setExtraHTTPHeaders(Object.fromEntries(session.extraHTTPHeaders));
        }
      }
      return {};
    }

    case "setCookie":
    case "setCookies": {
      if (!page) return {};
      const cookies = command === "setCookies"
        ? (params.cookies as Array<Record<string, unknown>>)
        : [params];
      for (const c of cookies) {
        await page.setCookie({
          name: c.name as string,
          value: c.value as string,
          domain: c.domain as string | undefined,
          path: c.path as string | undefined,
          secure: c.secure as boolean | undefined,
          httpOnly: c.httpOnly as boolean | undefined,
          sameSite: c.sameSite as "Strict" | "Lax" | "None" | undefined,
        });
      }
      return {};
    }

    case "getCookies": {
      if (!page) return { cookies: [] };
      const cookies = await page.cookies();
      return { cookies };
    }

    case "deleteCookies": {
      if (!page) return {};
      await page.deleteCookie({
        name: params.name as string,
        domain: params.domain as string | undefined,
        path: params.path as string | undefined,
      });
      return {};
    }

    case "clearBrowserCookies": {
      if (!page) return {};
      const all = await page.cookies();
      for (const c of all) await page.deleteCookie(c);
      return {};
    }

    case "setUserAgentOverride":
      if (page) await page.setUserAgent(params.userAgent as string);
      return {};

    default:
      throw new Error(`Unknown Network method: ${command}`);
  }
}

// ─── Emulation domain ────────────────────────────────────────────────────────

async function handleEmulation(
  page: Page,
  command: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (command) {
    case "setDeviceMetricsOverride":
      await page.setViewport({
        width: params.width as number,
        height: params.height as number,
        deviceScaleFactor: (params.deviceScaleFactor as number) || 1,
        isMobile: (params.mobile as boolean) || false,
        hasTouch: (params.mobile as boolean) || false,
      });
      return {};

    case "clearDeviceMetricsOverride":
      await page.setViewport({ width: 1280, height: 720 });
      return {};

    case "setUserAgentOverride":
      await page.setUserAgent(params.userAgent as string);
      return {};

    case "setGeolocationOverride":
      await page.setGeolocation({
        latitude: params.latitude as number,
        longitude: params.longitude as number,
        accuracy: params.accuracy as number | undefined,
      });
      return {};

    case "clearGeolocationOverride":
      return {};

    case "setTouchEmulationEnabled":
      return {};

    case "setEmulatedMedia":
      await page.emulateMediaType((params.media as string) || "");
      return {};

    case "setDefaultBackgroundColorOverride":
      return {};

    default:
      throw new Error(`Unknown Emulation method: ${command}`);
  }
}

// ─── Fetch domain (request interception) ─────────────────────────────────────

async function handleFetch(
  _session: CDPSession,
  page: Page,
  command: string,
  _params: Record<string, unknown>,
  _ws: WebSocket,
): Promise<unknown> {
  switch (command) {
    case "enable":
      await page.setRequestInterception(true);
      return {};

    case "disable":
      await page.setRequestInterception(false);
      return {};

    case "continueRequest":
    case "fulfillRequest":
    case "failRequest":
    case "getResponseBody":
      // Simplified: these need request tracking which is complex.
      // For the visual-diff use case, we don't need full request interception.
      return {};

    default:
      throw new Error(`Unknown Fetch method: ${command}`);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sendResponse(ws: WebSocket, id: number, result: unknown): void {
  ws.send(JSON.stringify({ id, result }));
}

function sendError(ws: WebSocket, id: number, code: number, message: string): void {
  ws.send(JSON.stringify({ id, error: { code, message } }));
}

function sendEvent(ws: WebSocket, method: string, params: unknown): void {
  ws.send(JSON.stringify({ method, params }));
}

function verifySecret(url: URL, env: Env): boolean {
  const provided = url.searchParams.get("secret");
  if (!provided || !env.CDP_SECRET) return false;
  return timingSafeEqual(provided, env.CDP_SECRET);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const encoder = new TextEncoder();
  return crypto.subtle.timingSafeEqual(encoder.encode(a), encoder.encode(b));
}
