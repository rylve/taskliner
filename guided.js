const guidedParams = new URLSearchParams(location.search);
const tutorialPathMode = guidedParams.has("tutorialPath") || /\/tutorial\/?$/.test(location.pathname);
const guided = guidedParams.has("guided") || tutorialPathMode;
if (guidedParams.has("tutorialPath") && location.pathname === "/") {
  history.replaceState(null, "", "/tutorial/");
}
if (!guided) {
  // The normal application has no guided overlay.
} else {
  let storedLocale = null;
  try {
    storedLocale = localStorage.getItem("taskliner-locale");
  } catch {
    /* ignore */
  }
  const browserLanguages = Array.isArray(navigator.languages)
    ? navigator.languages
    : [navigator.language || ""];
  const browserPrefersJa = browserLanguages.some((value) =>
    String(value || "").toLowerCase().startsWith("ja")
  );
  const ja = storedLocale === "ja" || (storedLocale !== "en" && browserPrefersJa);
  const ids = { root: "guided-root", seed: "guided-seed", tail: "guided-tail" };
  const copy = ja
    ? {
        device: "PC操作",
        finish: "チュートリアルを終了",
        sameLevel: "同じ段の上下の余白へドラッグしてください。",
        steps: [
          ["選んだ行で Enter を押す", "実際のタスクを選択し、Enter を押してください。選択した行の下に空行ができます。", "空行ができました。"],
          ["空行にタスクを書き込む", "できた空行にタスク名を書き込んでください。入力できたら自動で次へ進みます。", "タスクを書き込めました。"],
          ["↑↓でタスク間を移動する", "タスクを選んだまま、↓で次の行へ、↑で戻ってください。", "タスク間を移動できました。"],
          ["Tabで字下げする", "追加したタスクを選択したまま Tab を押し、前の項目の子にしてください。", "字下げできました。"],
          ["Shift+Tabで字上げする", "同じタスクで Shift+Tab を押し、元の階層へ戻してください。", "字上げできました。"],
          ["▼で折りたたむ / 展開する", "▼を押して子タスクを隠し、もう一度押して表示してください。", "折りたたみと展開を確認できました。"],
          ["必要な情報を詳細に残す", "右側の詳細パネルにメモを一言書いてください。アウトラインの短さを保ったまま、判断材料を残せます。", "詳細にメモを残せました。"],
          ["ドラッグハンドルで順番を変える", "行の左にある ⠿ をつかみ、同じ段の上下の余白へドラッグしてください。", "順番が変わりました。"],
          ["完了すると一覧から消える", "追加したタスクの完了ボタンを押してください。完了すると一覧から消えて、アーカイブに移ります。", "完了したタスクが一覧から消えました。"],
        ],
      }
    : {
        device: "Desktop",
        finish: "Exit tutorial",
        sameLevel: "Drag to the gap above or below a row at the same level.",
        steps: [
          ["Press Enter on the selected row", "Select the real task row and press Enter. A blank row appears below it.", "Blank row created."],
          ["Write the task in the blank row", "Write a task name in the blank row. The guide advances as soon as the title is entered.", "Task written."],
          ["Move between tasks with ↑↓", "With the task selected, press ↓ to move to the next row, then ↑ to return.", "Moved between tasks."],
          ["Indent with Tab", "With the added task selected, press Tab to make it a child of the previous item.", "Indented."],
          ["Outdent with Shift+Tab", "On the same task, press Shift+Tab to return it to its original level.", "Outdented."],
          ["Collapse and expand with ▼", "Press ▼ to hide the child tasks, then press it again to show them.", "Collapse and expand confirmed."],
          ["Keep useful context in details", "Write a short note in the detail pane. Keep the outline short while preserving useful context.", "Detail note added."],
          ["Change order with the drag handle", "Grab the ⠿ at the left of the row and drag it to a gap at the same level.", "Order changed."],
          ["Completion removes the row from the list", "Press Done on the task you added. It disappears from the list and moves to the archive.", "The completed task disappeared from the list."],
        ],
      };

  const coachStack = document.getElementById("guided-coach-stack");
  const backdrop = document.getElementById("guided-backdrop");
  const outline = document.getElementById("active-outline");
  const dataDialog = document.getElementById("guided-data-dialog");
  const dataTitle = document.getElementById("guided-data-title");
  const dataLead = document.getElementById("guided-data-lead");
  const dataStorage = document.getElementById("guided-data-storage");
  const dataBody = document.getElementById("guided-data-body");
  const dataContinue = document.getElementById("guided-data-continue");
  const completeDialog = document.getElementById("guided-complete-dialog");
  const completeTitle = document.getElementById("guided-complete-title");
  const completeCopy = document.getElementById("guided-complete-copy");
  const completeReturn = document.getElementById("guided-complete-return");
  const shareLabel = document.getElementById("guided-share-label");
  const shareNative = document.getElementById("guided-share-native");
  const shareX = document.getElementById("guided-share-x");
  const shareFacebook = document.getElementById("guided-share-facebook");
  const shareWhatsapp = document.getElementById("guided-share-whatsapp");
  const shareCopy = document.getElementById("guided-share-copy");
  const shareStatus = document.getElementById("guided-share-status");
  const SHARE_URL = "https://taskliner.app/";
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  const CARD_EXIT_MS = 460;
  const SUCCESS_HOLD_MS = 900;
  const FINISH_DIALOG_MS = 620;

  let coach = null;
  let count = null;
  let device = null;
  let title = null;
  let body = null;
  let status = null;
  let finish = null;

  let step = 0;
  let practiceId = null;
  let baseDepth = null;
  let movedAway = false;
  let movedBack = false;
  let collapsedOnce = false;
  let initialOrder = [];
  let transitioning = false;
  let completionRequested = false;
  let checkQueued = false;

  document.body.classList.add("is-guided-tutorial");

  const rows = () => [...(outline?.querySelectorAll('.row[data-id]') || [])];
  const row = (id) => (id ? outline?.querySelector(`.row[data-id="${CSS.escape(id)}"]`) : null);
  const practiceRow = () => row(practiceId);
  const selectedId = () => outline?.querySelector(".row.is-selected")?.dataset.id || null;
  const depth = (item) => (item ? Number(item.dataset.depth || 0) : null);
  const sameLevelIds = (level) => rows().filter((item) => depth(item) === level).map((item) => item.dataset.id);
  const returnToApp = () => {
    location.href = tutorialPathMode ? "../" : "./";
  };

  function createCoachCard() {
    const card = document.createElement("section");
    card.className = "guided-coach guided-card-enter";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-live", "polite");
    card.setAttribute("aria-label", "Tutorial step");
    card.innerHTML = `
      <div class="guided-progress"><span class="guided-count"></span><span class="guided-device"></span></div>
      <h2 class="guided-title"></h2>
      <p class="guided-copy"></p>
      <p class="guided-status" aria-live="polite"></p>
      <button type="button" class="pop-btn pop-btn--cta pop-btn--sm guided-finish" hidden></button>
    `;
    return card;
  }

  function bindCoachCard(card) {
    coach = card;
    count = card.querySelector(".guided-count");
    device = card.querySelector(".guided-device");
    title = card.querySelector(".guided-title");
    body = card.querySelector(".guided-copy");
    status = card.querySelector(".guided-status");
    finish = card.querySelector(".guided-finish");
    finish.addEventListener("click", returnToApp);
  }

  function ensureCoachCard() {
    if (coach) return;
    const card = createCoachCard();
    card.classList.remove("guided-card-enter");
    coachStack.appendChild(card);
    bindCoachCard(card);
  }

  function exitCoachCard(card, onDone) {
    if (!card || reducedMotion) {
      card?.remove();
      onDone();
      return;
    }
    let exitFinished = false;
    const finishExit = () => {
      if (exitFinished) return;
      exitFinished = true;
      card.removeEventListener("animationend", onExitEnd);
      card.remove();
      onDone();
    };
    const onExitEnd = (event) => {
      if (event.animationName === "guided-card-exit") finishExit();
    };
    card.classList.remove("is-guided-success");
    void card.offsetWidth;
    card.addEventListener("animationend", onExitEnd);
    card.classList.add("guided-card-exit");
    window.setTimeout(finishExit, CARD_EXIT_MS + 80);
  }

  function slideToStep(nextStep) {
    const previous = coach;
    step = nextStep;
    const next = createCoachCard();
    coachStack.appendChild(next);
    bindCoachCard(next);
    renderGuide();

    const beginEnter = () => {
      previous?.remove();
      if (reducedMotion) {
        next.classList.remove("guided-card-enter");
        transitioning = false;
        scheduleCheck();
        return;
      }
      const onEnterEnd = (event) => {
        if (event.animationName !== "guided-card-enter") return;
        next.removeEventListener("animationend", onEnterEnd);
        transitioning = false;
        scheduleCheck();
      };
      next.addEventListener("animationend", onEnterEnd);
      window.requestAnimationFrame(() => next.classList.add("guided-card-enter-active"));
    };

    if (!previous) {
      beginEnter();
      return;
    }
    exitCoachCard(previous, beginEnter);
  }

  function setBackdropVisible(visible) {
    if (!backdrop) return;
    if (visible) {
      backdrop.hidden = false;
      backdrop.setAttribute("aria-hidden", "false");
      window.requestAnimationFrame(() => backdrop.classList.add("is-guided-backdrop-visible"));
      return;
    }
    backdrop.classList.remove("is-guided-backdrop-visible");
    backdrop.setAttribute("aria-hidden", "true");
    window.setTimeout(() => {
      if (!backdrop.classList.contains("is-guided-backdrop-visible")) backdrop.hidden = true;
    }, reducedMotion ? 0 : 280);
  }

  function celebrate() {
    if (reducedMotion || !coach) return;
    const rect = coach.getBoundingClientRect();
    const burst = document.createElement("div");
    burst.className = "guided-celebration";
    burst.style.left = `${rect.left + rect.width / 2}px`;
    burst.style.top = `${rect.top + 18}px`;
    const colors = ["var(--pop-accent)", "var(--pop-marker)", "#2f7fbd", "#e35d6a", "#49a078"];
    for (let index = 0; index < 18; index += 1) {
      const piece = document.createElement("span");
      const angle = (Math.PI * 2 * index) / 18;
      const distance = 46 + (index % 4) * 16;
      piece.className = "guided-confetti-piece";
      piece.style.setProperty("--confetti-x", `${Math.cos(angle) * distance}px`);
      piece.style.setProperty("--confetti-y", `${Math.sin(angle) * distance - 18}px`);
      piece.style.setProperty("--confetti-r", `${(index % 2 ? 1 : -1) * (180 + index * 17)}deg`);
      piece.style.setProperty("--confetti-color", colors[index % colors.length]);
      piece.style.setProperty("--confetti-delay", `${(index % 5) * 18}ms`);
      burst.appendChild(piece);
    }
    document.body.appendChild(burst);
    window.setTimeout(() => burst.remove(), 900);
  }

  function showCompletionDialog() {
    const shareText = ja ? "Tasklinerをはじめました！" : "I’ve started using Taskliner!";
    const sharePayload = `${shareText}\n${SHARE_URL}\n#Taskliner`;
    completeTitle.textContent = ja ? "おめでとうございます！" : "Congratulations!";
    completeCopy.textContent = ja
      ? "Tasklinerを完璧に理解されましたね。\nそれでは、実際に使ってみましょう！"
      : "You have mastered Taskliner.\nNow let’s use it for real!";
    completeReturn.textContent = ja ? "チュートリアルを終了" : "Exit tutorial";
    shareLabel.textContent = ja ? "シェアする" : "Share your start";
    shareNative.textContent = ja ? "共有" : "Share";
    shareCopy.textContent = ja ? "リンクをコピー" : "Copy link";
    shareStatus.textContent = "";
    shareX.href = `https://twitter.com/intent/tweet?text=${encodeURIComponent(sharePayload)}`;
    shareFacebook.href = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(SHARE_URL)}&quote=${encodeURIComponent(shareText)}`;
    shareWhatsapp.href = `https://wa.me/?text=${encodeURIComponent(sharePayload)}`;
    completeDialog.showModal();
  }

  function showDataDialog() {
    if (!dataDialog) {
      showCompletionDialog();
      return;
    }
    dataTitle.textContent = ja ? "データについて" : "About your data";
    dataLead.textContent = ja ? "Tasklinerは登録不要で使えます。" : "Taskliner works without registration.";
    dataStorage.textContent = ja
      ? "タスクはあなたの端末内のサイトデータとして保存されます。"
      : "Your tasks are saved as site data on your device.";
    dataBody.textContent = ja
      ? "Googleアカウントを接続すると、端末間でタスクを同期できます。ブラウザのデータが消えても、同じGoogleアカウントを接続すれば復元できます。"
      : "Connect a Google account to sync tasks across devices. If this browser’s data is deleted, reconnect the same Google account to restore your tasks.";
    dataContinue.textContent = ja ? "次へ" : "Next";
    dataDialog.showModal();
  }

  function finishGuide() {
    if (transitioning) return;
    transitioning = true;
    status.dataset.keep = copy.steps[8][2];
    status.textContent = copy.steps[8][2];
    coach.classList.add("is-guided-success");
    celebrate();
    document.querySelectorAll(".guided-spotlight").forEach((element) => element.classList.remove("guided-spotlight"));
    setBackdropVisible(false);
    window.setTimeout(() => {
      const completedCard = coach;
      exitCoachCard(completedCard, () => {
        coachStack.hidden = true;
        showDataDialog();
      });
    }, reducedMotion ? 220 : FINISH_DIALOG_MS);
  }

  function targetForStep() {
    const current = practiceRow();
    if (step === 0) return row(ids.seed);
    if (step === 1) return current;
    if (step === 2) return row(selectedId()) || current;
    if (step >= 3 && step <= 4) return current;
    if (step === 5) return row(ids.root)?.querySelector(".toggle");
    if (step === 6) return document.querySelector(".detail-pane");
    if (step === 7) return current?.querySelector(".drag-handle");
    return current?.querySelector(".done-btn");
  }

  function setSpotlight(target) {
    document.querySelectorAll(".guided-spotlight").forEach((element) => element.classList.remove("guided-spotlight"));
    target?.classList.add("guided-spotlight");
    if (target) {
      const rect = target.getBoundingClientRect();
      backdrop.style.setProperty("--guided-top", `${Math.max(0, rect.top - 8)}px`);
      backdrop.style.setProperty("--guided-left", `${Math.max(0, rect.left - 8)}px`);
      backdrop.style.setProperty("--guided-right", `${Math.min(window.innerWidth, rect.right + 8)}px`);
      backdrop.style.setProperty("--guided-bottom", `${Math.min(window.innerHeight, rect.bottom + 8)}px`);
    }
    setBackdropVisible(Boolean(target));
  }

  function renderGuide() {
    ensureCoachCard();
    const item = copy.steps[step];
    count.textContent = `${step + 1} / ${copy.steps.length}`;
    device.textContent = copy.device;
    title.textContent = item[0];
    body.textContent = item[1];
    coach.setAttribute("aria-label", item[0]);
    status.textContent = status.dataset.keep || "";
    finish.textContent = copy.finish;
    finish.hidden = step !== copy.steps.length - 1;

    const target = targetForStep();
    if (step === 7 && !initialOrder.length && practiceRow()) initialOrder = sameLevelIds(baseDepth);
    coach.hidden = false;
    setSpotlight(target);
  }

  function acknowledge(nextStep, message) {
    if (transitioning) return;
    transitioning = true;
    if (nextStep === 2) {
      movedAway = false;
      movedBack = false;
    }
    status.dataset.keep = message;
    status.textContent = message;
    coach.classList.add("is-guided-success");
    if (step === 0) setSpotlight(practiceRow());
    if (step === 2) setSpotlight(row(selectedId()) || practiceRow());
    if (step === 7) setSpotlight(practiceRow()?.querySelector(".drag-handle"));
    celebrate();
    window.setTimeout(() => {
      slideToStep(nextStep);
    }, reducedMotion ? 260 : SUCCESS_HOLD_MS);
  }

  function scheduleCheck(delay = 0) {
    if (checkQueued) return;
    checkQueued = true;
    window.setTimeout(() => {
      checkQueued = false;
      check();
    }, delay);
  }

  function check() {
    if (transitioning || !outline) return;
    const current = practiceRow();
    if (step === 0) {
      const created = rows().find((item) => !Object.values(ids).includes(item.dataset.id));
      if (created) {
        practiceId = created.dataset.id;
        baseDepth = depth(created);
        acknowledge(1, copy.steps[0][2]);
        return;
      }
      return;
    }
    if (!current) {
      if (step === 5) {
        if (!row(ids.seed)) collapsedOnce = true;
        return;
      }
      if (step === copy.steps.length - 1 && completionRequested) {
        finishGuide();
      }
      return;
    }
    if (step === 1 && current.querySelector(".title-input")?.value.trim()) {
      acknowledge(2, copy.steps[1][2]);
      return;
    } else if (step === 2) {
      setSpotlight(row(selectedId()) || current);
      if (movedAway && movedBack && selectedId() === practiceId) {
        acknowledge(3, copy.steps[2][2]);
        return;
      }
    } else if (step === 3 && depth(current) > baseDepth) {
      acknowledge(4, copy.steps[3][2]);
      return;
    } else if (step === 4 && depth(current) === baseDepth) {
      acknowledge(5, copy.steps[4][2]);
      return;
    } else if (step === 5) {
      const seedVisible = !!row(ids.seed);
      if (!seedVisible) collapsedOnce = true;
      if (collapsedOnce && seedVisible) {
        acknowledge(6, copy.steps[5][2]);
        return;
      }
    } else if (step === 6 && document.getElementById("detail-note")?.value.trim()) {
      acknowledge(7, copy.steps[6][2]);
      return;
    } else if (step === 7) {
      setSpotlight(current.querySelector(".drag-handle"));
      if (depth(current) !== baseDepth) {
        status.dataset.keep = copy.sameLevel;
        status.textContent = copy.sameLevel;
        return;
      }
      const order = sameLevelIds(baseDepth);
      if (initialOrder.length && order.join("|") !== initialOrder.join("|") && order.includes(practiceId)) {
        acknowledge(8, copy.steps[7][2]);
        return;
      }
    }
    renderGuide();
  }

  document.addEventListener(
    "keydown",
    (event) => {
      if ((step === 3 || step === 4) && event.key === "Tab") {
        window.setTimeout(() => check(), 0);
        return;
      }
      if (step !== 2) return;
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        window.setTimeout(() => {
          if (selectedId() !== practiceId) movedAway = true;
          else if (movedAway) movedBack = true;
          setSpotlight(row(selectedId()) || practiceRow());
          check();
        }, 0);
      }
    },
    true
  );
  document.addEventListener("input", () => scheduleCheck(), true);
  document.addEventListener(
    "click",
    (event) => {
      if (step === copy.steps.length - 1 && event.target?.closest?.(`.row[data-id="${CSS.escape(practiceId || "")}"] .done-btn`)) {
        completionRequested = true;
        scheduleCheck(260);
      }
    },
    true
  );

  const observer = new MutationObserver(() => {
    if (step === 7 && !initialOrder.length && practiceRow()) initialOrder = sameLevelIds(baseDepth);
    scheduleCheck();
  });
  observer.observe(outline, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-depth"] });
  completeReturn.addEventListener("click", returnToApp);
  shareNative?.addEventListener("click", async () => {
    const shareText = ja ? "Tasklinerをはじめました！" : "I’ve started using Taskliner!";
    try {
      await navigator.share({ title: "Taskliner", text: shareText, url: "https://taskliner.app/" });
    } catch (error) {
      if (error?.name !== "AbortError") shareStatus.textContent = ja ? "共有できませんでした。" : "Sharing was not available.";
    }
  });
  shareCopy?.addEventListener("click", async () => {
    const shareText = ja ? "Tasklinerをはじめました！" : "I’ve started using Taskliner!";
    const sharePayload = `${shareText}\n${SHARE_URL}\n#Taskliner`;
    try {
      await navigator.clipboard.writeText(sharePayload);
      shareStatus.textContent = ja ? "共有文をコピーしました。" : "Share text copied.";
    } catch {
      shareStatus.textContent = ja ? "コピーできませんでした。" : "Could not copy the share text.";
    }
  });
  if (shareNative && typeof navigator.share === "function") shareNative.hidden = false;
  dataContinue?.addEventListener("click", () => {
    dataDialog?.close();
    showCompletionDialog();
  });
  renderGuide();
  scheduleCheck();
}
