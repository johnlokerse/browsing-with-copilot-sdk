(function () {
  const HIGHLIGHT_BOX_ID = "__copilot_highlight_box";
  const HIGHLIGHT_LABEL_ID = "__copilot_highlight_label";
  const HUD_ID = "__copilot_hud";

  function log(...args) {
    console.log("[copilot-content]", ...args);
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(value);
    }
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function attrEscape(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function isVisible(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const style = window.getComputedStyle(element);
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function getElementLabel(element) {
    const aria = element.getAttribute("aria-label");
    if (aria && aria.trim()) {
      return aria.trim();
    }

    const text = (element.innerText || element.textContent || "").trim();
    if (text) {
      return text.replace(/\s+/g, " ").slice(0, 120);
    }

    const inputValue = element instanceof HTMLInputElement ? element.value : "";
    if (inputValue && inputValue.trim()) {
      return inputValue.trim();
    }

    const placeholder = element.getAttribute("placeholder");
    if (placeholder && placeholder.trim()) {
      return placeholder.trim();
    }

    const name = element.getAttribute("name");
    if (name && name.trim()) {
      return name.trim();
    }

    return element.tagName.toLowerCase();
  }

  function isUniqueSelector(selector) {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch {
      return false;
    }
  }

  function buildSelector(element) {
    if (element.id) {
      const selector = `#${cssEscape(element.id)}`;
      if (isUniqueSelector(selector)) {
        return selector;
      }
    }

    const tag = element.tagName.toLowerCase();
    const name = element.getAttribute("name");
    if (name) {
      const selector = `${tag}[name="${attrEscape(name)}"]`;
      if (isUniqueSelector(selector)) {
        return selector;
      }
    }

    const ariaLabel = element.getAttribute("aria-label");
    if (ariaLabel) {
      const selector = `${tag}[aria-label="${attrEscape(ariaLabel)}"]`;
      if (isUniqueSelector(selector)) {
        return selector;
      }
    }

    const testId = element.getAttribute("data-testid") || element.getAttribute("data-test-id");
    if (testId) {
      const selector = `${tag}[data-testid="${attrEscape(testId)}"]`;
      if (isUniqueSelector(selector)) {
        return selector;
      }
    }

    const role = element.getAttribute("role");
    if (role) {
      const selector = `${tag}[role="${attrEscape(role)}"]`;
      if (isUniqueSelector(selector)) {
        return selector;
      }
    }

    const segments = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && segments.length < 5) {
      const currentTag = current.tagName.toLowerCase();
      const parent = current.parentElement;
      if (!parent) {
        break;
      }
      const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
      const index = siblings.indexOf(current) + 1;
      segments.unshift(`${currentTag}:nth-of-type(${index})`);
      const selector = segments.join(" > ");
      if (isUniqueSelector(selector)) {
        return selector;
      }
      current = parent;
    }

    return segments.join(" > ") || tag;
  }

  function normalizeText(value) {
    return String(value || "").toLowerCase().trim();
  }

  function rankCandidate(element, queryText) {
    const label = normalizeText(getElementLabel(element));
    const role = normalizeText(element.getAttribute("role"));
    const name = normalizeText(element.getAttribute("name"));
    const placeholder = normalizeText(element.getAttribute("placeholder"));
    const href = normalizeText(element.getAttribute("href"));
    const query = normalizeText(queryText);

    if (!query) {
      return 0;
    }

    let score = 0;
    const tokens = query.split(/\s+/).filter(Boolean);

    if (label.includes(query)) {
      score += 80;
    }
    if (name.includes(query) || placeholder.includes(query)) {
      score += 50;
    }
    if (role.includes(query)) {
      score += 20;
    }
    if (href.includes(query)) {
      score += 20;
    }

    for (const token of tokens) {
      if (label.includes(token)) {
        score += 15;
      }
      if (name.includes(token) || placeholder.includes(token)) {
        score += 10;
      }
      if (role.includes(token)) {
        score += 5;
      }
      if (href.includes(token)) {
        score += 5;
      }
    }

    if (isVisible(element)) {
      score += 10;
    }

    return score;
  }

  function findCandidates(query) {
    const selector = [
      "button",
      "a[href]",
      "a[role='button']",
      "input",
      "textarea",
      "select",
      "[role='button']",
      "[aria-label]",
      "[name]",
      "[placeholder]",
      "[contenteditable='true']",
    ].join(",");

    const elements = Array.from(document.querySelectorAll(selector));
    const ranked = elements
      .filter((element) => element instanceof HTMLElement)
      .filter((element) => isVisible(element))
      .map((element) => ({
        element,
        score: rankCandidate(element, query),
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);

    const candidates = ranked.map((item, index) => {
      const label = getElementLabel(item.element);
      return {
        id: `cand-${index + 1}`,
        label,
        selector: buildSelector(item.element),
      };
    });

    return { candidates };
  }

  function getTarget(selector) {
    if (!selector || typeof selector !== "string") {
      return null;
    }

    try {
      return document.querySelector(selector);
    } catch {
      return null;
    }
  }

  function ensureHighlightElements() {
    let box = document.getElementById(HIGHLIGHT_BOX_ID);
    if (!box) {
      box = document.createElement("div");
      box.id = HIGHLIGHT_BOX_ID;
      box.style.position = "fixed";
      box.style.zIndex = "2147483646";
      box.style.border = "3px solid #ff8a00";
      box.style.background = "rgba(255, 138, 0, 0.08)";
      box.style.pointerEvents = "none";
      box.style.boxSizing = "border-box";
      box.style.borderRadius = "6px";
      document.documentElement.appendChild(box);
    }

    let label = document.getElementById(HIGHLIGHT_LABEL_ID);
    if (!label) {
      label = document.createElement("div");
      label.id = HIGHLIGHT_LABEL_ID;
      label.style.position = "fixed";
      label.style.zIndex = "2147483647";
      label.style.pointerEvents = "none";
      label.style.background = "#ff8a00";
      label.style.color = "#111";
      label.style.font = "12px/1.4 ui-sans-serif, -apple-system, Segoe UI, sans-serif";
      label.style.padding = "3px 8px";
      label.style.borderRadius = "999px";
      label.style.maxWidth = "60vw";
      label.style.whiteSpace = "nowrap";
      label.style.overflow = "hidden";
      label.style.textOverflow = "ellipsis";
      document.documentElement.appendChild(label);
    }

    return { box, label };
  }

  function highlightElement(element, labelText) {
    const rect = element.getBoundingClientRect();
    const { box, label } = ensureHighlightElements();

    box.style.display = "block";
    box.style.left = `${Math.max(0, rect.left - 3)}px`;
    box.style.top = `${Math.max(0, rect.top - 3)}px`;
    box.style.width = `${Math.max(0, rect.width + 6)}px`;
    box.style.height = `${Math.max(0, rect.height + 6)}px`;

    label.style.display = "block";
    label.textContent = labelText || getElementLabel(element);
    label.style.left = `${Math.max(0, rect.left)}px`;
    label.style.top = `${Math.max(0, rect.top - 28)}px`;
  }

  function ensureHud() {
    let hud = document.getElementById(HUD_ID);
    if (!hud) {
      hud = document.createElement("div");
      hud.id = HUD_ID;
      hud.style.position = "fixed";
      hud.style.top = "12px";
      hud.style.right = "12px";
      hud.style.zIndex = "2147483647";
      hud.style.background = "rgba(16, 25, 40, 0.92)";
      hud.style.color = "#f8fbff";
      hud.style.padding = "10px 12px";
      hud.style.borderRadius = "8px";
      hud.style.font = "12px/1.45 ui-sans-serif, -apple-system, Segoe UI, sans-serif";
      hud.style.maxWidth = "320px";
      hud.style.boxShadow = "0 10px 30px rgba(0,0,0,0.35)";
      hud.style.pointerEvents = "none";
      document.documentElement.appendChild(hud);
    }
    return hud;
  }

  function setHud(message) {
    const hud = ensureHud();
    hud.textContent = message;
  }

  function typeIntoElement(element, text) {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      element.focus();
      const proto = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (nativeSetter) {
        nativeSetter.call(element, text);
      } else {
        element.value = text;
      }
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }

    if (element instanceof HTMLElement && element.isContentEditable) {
      element.focus();
      element.textContent = text;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }

    return false;
  }

  async function handleToolMessage(message) {
    if (!message || message.kind !== "copilot_tool") {
      return { ok: false, error: "EXTENSION_NOT_READY" };
    }

    try {
      if (message.action === "hud") {
        setHud(String(message.message || ""));
        return { ok: true, data: { ok: true } };
      }

      if (message.action === "find") {
        const query = String(message.query || "");
        const result = findCandidates(query);
        return { ok: true, data: result };
      }

      if (message.action === "highlight") {
        const selector = String(message.selector || "");
        const target = getTarget(selector);
        if (!target || !(target instanceof HTMLElement)) {
          return { ok: false, error: "NOT_FOUND" };
        }
        target.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
        highlightElement(target, String(message.label || ""));
        return { ok: true, data: { ok: true } };
      }

      if (message.action === "click") {
        const selector = String(message.selector || "");
        const target = getTarget(selector);
        if (!target || !(target instanceof HTMLElement)) {
          return { ok: false, error: "NOT_FOUND" };
        }
        if (!isVisible(target)) {
          return { ok: false, error: "NOT_FOUND" };
        }
        target.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
        highlightElement(target, "click target");
        target.click();
        return { ok: true, data: { ok: true } };
      }

      if (message.action === "type") {
        const selector = String(message.selector || "");
        const text = String(message.text || "");
        const target = getTarget(selector);
        if (!target || !(target instanceof HTMLElement)) {
          return { ok: false, error: "NOT_FOUND" };
        }
        target.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
        highlightElement(target, "type target");
        const typed = typeIntoElement(target, text);
        if (!typed) {
          return { ok: false, error: "NOT_FOUND" };
        }
        return { ok: true, data: { ok: true } };
      }

      return { ok: false, error: "EXTENSION_NOT_READY" };
    } catch (error) {
      log("Tool handling failed", error);
      return { ok: false, error: "EXTENSION_NOT_READY" };
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    handleToolMessage(message).then(sendResponse);
    return true;
  });

  log("Content script ready");
})();
