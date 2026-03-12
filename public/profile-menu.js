(() => {
  const EDIT_LABEL = "Edit profile";
  const LOGOUT_LABELS = new Set([
    "Logout",
    "Log out",
    "Sign out",
    "Sign Out",
  ]);
  const MAX_SIZE = 2 * 1024 * 1024;
  const MODAL_ID = "nixer-profile-editor-modal";
  const STYLE_ID = "nixer-profile-editor-style";

  let pendingAvatarData = "";
  let isSaving = false;

  function getTextContent(node) {
    return String(node?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function isLogoutCandidate(node) {
    const text = getTextContent(node);
    if (LOGOUT_LABELS.has(text)) return true;
    return /sign\s*out|log\s*out/i.test(text);
  }

  async function fetchStatus() {
    const response = await fetch("/api/v1/status", { credentials: "include" });
    const payload = await response.json();
    return payload?.data?.user || null;
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${MODAL_ID}[hidden] { display: none !important; }
      #${MODAL_ID} {
        position: fixed;
        inset: 0;
        z-index: 99999;
        display: flex;
        align-items: flex-start;
        justify-content: center;
        padding-top: min(12vh, 96px);
        padding-left: 16px;
        padding-right: 16px;
        box-sizing: border-box;
      }
      #${MODAL_ID} .nixer-profile-editor-backdrop {
        position: absolute;
        inset: 0;
        background:
          radial-gradient(circle at top, rgba(72, 108, 255, 0.12), transparent 35%),
          rgba(4, 5, 8, 0.78);
        backdrop-filter: blur(12px);
      }
      #${MODAL_ID} .nixer-profile-editor-dialog {
        position: relative;
        width: min(92vw, 440px);
        border-radius: 24px;
        border: 1px solid rgba(255, 255, 255, 0.08);
        background:
          linear-gradient(180deg, rgba(22, 25, 34, 0.98), rgba(11, 13, 19, 0.98));
        box-shadow: 0 32px 90px rgba(0, 0, 0, 0.58);
        padding: 24px;
        color: #f5f7fb;
      }
      #${MODAL_ID} .nixer-profile-editor-title {
        margin: 0 0 4px;
        font-size: 1.2rem;
        font-weight: 700;
      }
      #${MODAL_ID} .nixer-profile-editor-subtitle {
        margin: 0 0 18px;
        color: #8c93a8;
        font-size: 0.92rem;
        line-height: 1.45;
      }
      #${MODAL_ID} .nixer-profile-editor-avatar-wrap {
        display: flex;
        justify-content: center;
        margin-bottom: 18px;
      }
      #${MODAL_ID} .nixer-profile-editor-avatar {
        width: 112px;
        height: 112px;
        border-radius: 999px;
        object-fit: cover;
        border: 2px solid rgba(164, 147, 255, 0.6);
        box-shadow: 0 0 0 6px rgba(255, 255, 255, 0.03);
        background: #161922;
      }
      #${MODAL_ID} .nixer-profile-editor-field {
        margin-bottom: 14px;
      }
      #${MODAL_ID} .nixer-profile-editor-label {
        display: block;
        margin-bottom: 7px;
        color: #9da5bb;
        font-size: 0.88rem;
      }
      #${MODAL_ID} .nixer-profile-editor-input {
        width: 100%;
        box-sizing: border-box;
        padding: 12px 14px;
        border-radius: 14px;
        border: 1px solid rgba(255, 255, 255, 0.08);
        background: rgba(255, 255, 255, 0.03);
        color: #f5f7fb;
        font-size: 0.98rem;
      }
      #${MODAL_ID} .nixer-profile-editor-input:focus {
        outline: none;
        border-color: rgba(126, 149, 255, 0.75);
        box-shadow: 0 0 0 3px rgba(97, 127, 255, 0.14);
      }
      #${MODAL_ID} .nixer-profile-editor-upload {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        box-sizing: border-box;
        padding: 12px 14px;
        border-radius: 14px;
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid rgba(255, 255, 255, 0.08);
        color: #f5f7fb;
        cursor: pointer;
        font-size: 0.92rem;
      }
      #${MODAL_ID} .nixer-profile-editor-upload:hover {
        background: rgba(255, 255, 255, 0.08);
      }
      #${MODAL_ID} .nixer-profile-editor-file {
        display: none;
      }
      #${MODAL_ID} .nixer-profile-editor-message {
        min-height: 20px;
        margin: 10px 0 0;
        font-size: 0.9rem;
      }
      #${MODAL_ID} .nixer-profile-editor-message.error { color: #ff8585; }
      #${MODAL_ID} .nixer-profile-editor-message.success { color: #7ff0a5; }
      #${MODAL_ID} .nixer-profile-editor-actions {
        display: flex;
        gap: 10px;
        justify-content: flex-end;
        margin-top: 18px;
      }
      #${MODAL_ID} .nixer-profile-editor-btn {
        border: 0;
        border-radius: 14px;
        padding: 12px 16px;
        font-weight: 700;
        cursor: pointer;
      }
      #${MODAL_ID} .nixer-profile-editor-btn.cancel {
        background: rgba(255, 255, 255, 0.06);
        color: #d4d9df;
      }
      #${MODAL_ID} .nixer-profile-editor-btn.save {
        background: linear-gradient(135deg, #6f6bff, #4091ff);
        color: white;
      }
      #${MODAL_ID} .nixer-profile-editor-btn:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }
    `;
    document.head.appendChild(style);
  }

  function ensureModal() {
    ensureStyle();
    let modal = document.getElementById(MODAL_ID);
    if (modal) return modal;

    modal = document.createElement("div");
    modal.id = MODAL_ID;
    modal.hidden = true;
    modal.innerHTML = `
      <div class="nixer-profile-editor-backdrop" data-close-modal="true"></div>
      <div class="nixer-profile-editor-dialog" role="dialog" aria-modal="true" aria-labelledby="${MODAL_ID}-title">
        <h2 class="nixer-profile-editor-title" id="${MODAL_ID}-title">Edit profile</h2>
        <p class="nixer-profile-editor-subtitle">Update your username and avatar directly inside the NodeFull client.</p>
        <div class="nixer-profile-editor-avatar-wrap">
          <img class="nixer-profile-editor-avatar" id="${MODAL_ID}-avatar" alt="Profile picture">
        </div>
        <div class="nixer-profile-editor-field">
          <label class="nixer-profile-editor-label" for="${MODAL_ID}-username">Username</label>
          <input class="nixer-profile-editor-input" id="${MODAL_ID}-username" type="text" maxlength="40" placeholder="Your username">
        </div>
        <div class="nixer-profile-editor-field">
          <label class="nixer-profile-editor-label" for="${MODAL_ID}-file">Profile picture</label>
          <label class="nixer-profile-editor-upload" for="${MODAL_ID}-file">Choose a new avatar</label>
          <input class="nixer-profile-editor-file" id="${MODAL_ID}-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif">
        </div>
        <div class="nixer-profile-editor-message" id="${MODAL_ID}-message"></div>
        <div class="nixer-profile-editor-actions">
          <button class="nixer-profile-editor-btn cancel" type="button" data-close-modal="true">Cancel</button>
          <button class="nixer-profile-editor-btn save" type="button" id="${MODAL_ID}-save">Save changes</button>
        </div>
      </div>
    `;

    modal.addEventListener("click", (event) => {
      const target = event.target;
      if (target && target.getAttribute("data-close-modal") === "true") {
        closeModal();
      }
    });

    modal.querySelector(`#${MODAL_ID}-file`).addEventListener("change", handleFileChange);
    modal.querySelector(`#${MODAL_ID}-save`).addEventListener("click", saveProfile);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !modal.hidden) {
        closeModal();
      }
    });

    document.body.appendChild(modal);
    return modal;
  }

  function setMessage(message, type) {
    const modal = ensureModal();
    const node = modal.querySelector(`#${MODAL_ID}-message`);
    node.textContent = message || "";
    node.className = "nixer-profile-editor-message" + (type ? ` ${type}` : "");
  }

  function closeModal() {
    const modal = ensureModal();
    pendingAvatarData = "";
    setMessage("", "");
    modal.hidden = true;
    document.body.style.removeProperty("overflow");
  }

  async function openModal() {
    const modal = ensureModal();
    const avatar = modal.querySelector(`#${MODAL_ID}-avatar`);
    const username = modal.querySelector(`#${MODAL_ID}-username`);
    const saveButton = modal.querySelector(`#${MODAL_ID}-save`);

    pendingAvatarData = "";
    setMessage("", "");
    saveButton.disabled = true;
    modal.hidden = false;
    document.body.style.overflow = "hidden";

    try {
      const user = await fetchStatus();
      if (!user || user.isSimulated) {
        throw new Error("No local user is signed in.");
      }
      username.value = user.viewer?.name || "";
      avatar.src = user.viewer?.avatar?.large || "/no-cover.png";
      saveButton.disabled = false;
      username.focus();
      username.select();
    } catch (error) {
      setMessage(error?.message || "Profile data could not be loaded.", "error");
    }
  }

  function handleFileChange(event) {
    const file = event.target?.files?.[0];
    if (!file) return;
    if (file.size > MAX_SIZE) {
      setMessage("The image must be smaller than 2 MB.", "error");
      event.target.value = "";
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      pendingAvatarData = String(reader.result || "");
      const modal = ensureModal();
      const avatar = modal.querySelector(`#${MODAL_ID}-avatar`);
      avatar.src = pendingAvatarData || avatar.src;
      setMessage("", "");
    };
    reader.onerror = () => {
      setMessage("The selected image could not be read.", "error");
    };
    reader.readAsDataURL(file);
  }

  async function saveProfile() {
    if (isSaving) return;

    const modal = ensureModal();
    const username = modal.querySelector(`#${MODAL_ID}-username`).value.trim();
    const saveButton = modal.querySelector(`#${MODAL_ID}-save`);
    if (!username) {
      setMessage("Username cannot be empty.", "error");
      return;
    }

    isSaving = true;
    saveButton.disabled = true;
    setMessage("Saving changes...", "success");

    try {
      const response = await fetch("/api/v1/auth/update", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          username,
          avatarData: pendingAvatarData,
        }),
      });

      const payload = await response.json();
      if (!response.ok || payload?.error) {
        throw new Error(payload?.error || "Profile changes could not be saved.");
      }

      setMessage("Profile updated. Reloading...", "success");
      window.setTimeout(() => {
        window.location.reload();
      }, 300);
    } catch (error) {
      setMessage(error?.message || "Profile changes could not be saved.", "error");
      saveButton.disabled = false;
      isSaving = false;
    }
  }

  function createEditButton(logoutButton) {
    const button = document.createElement(logoutButton.tagName === "BUTTON" ? "button" : "div");
    if (button.tagName === "BUTTON") {
      button.type = "button";
    }

    button.className = logoutButton.className;
    if (logoutButton.getAttribute("role")) {
      button.setAttribute("role", logoutButton.getAttribute("role"));
    }
    if (logoutButton.tabIndex >= 0) {
      button.tabIndex = logoutButton.tabIndex;
    }
    button.dataset.nixerProfileEdit = "true";
    button.textContent = EDIT_LABEL;
    button.style.display = "flex";
    button.style.alignItems = "center";
    button.style.width = "100%";
    button.style.cursor = "pointer";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openModal();
    });

    return button;
  }

  function injectProfileMenuItem() {
    const candidates = Array.from(document.querySelectorAll("button,[role='menuitem'],[data-radix-collection-item]"));
    for (const candidate of candidates) {
      if (candidate.dataset.nixerProfileEdit === "true") continue;
      if (!isLogoutCandidate(candidate)) continue;
      const parent = candidate.parentElement;
      if (!parent || parent.querySelector("[data-nixer-profile-edit='true']")) continue;
      parent.insertBefore(createEditButton(candidate), candidate);
    }
  }

  const observer = new MutationObserver(() => {
    injectProfileMenuItem();
  });

  document.addEventListener("DOMContentLoaded", () => {
    ensureModal();
    injectProfileMenuItem();
    observer.observe(document.body, { childList: true, subtree: true });
  });
})();
