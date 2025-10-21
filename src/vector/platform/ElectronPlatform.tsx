/*
Copyright 2024-2025 New Vector Ltd.
Copyright 2022 Šimon Brandner <simon.bra.ag@gmail.com>
Copyright 2018-2021 New Vector Ltd
Copyright 2019 Michael Telatynski <7t3chguy@gmail.com>
Copyright 2016 Aviral Dasgupta
Copyright 2016 OpenMarket Ltd

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import {
    type MatrixClient,
    type Room,
    type MatrixEvent,
    type OidcRegistrationClientMetadata,
} from "matrix-js-sdk/src/matrix";
import React from "react";
import { logger } from "matrix-js-sdk/src/logger";
import { uniqueId } from "lodash";

import BasePlatform, { UpdateCheckStatus, type UpdateStatus } from "../../BasePlatform";
import type BaseEventIndexManager from "../../indexing/BaseEventIndexManager";
import dis from "../../dispatcher/dispatcher";
import SdkConfig from "../../SdkConfig";
import { type IConfigOptions } from "../../IConfigOptions";
import * as rageshake from "../../rageshake/rageshake";
import Modal from "../../Modal";
import InfoDialog from "../../components/views/dialogs/InfoDialog";
import Spinner from "../../components/views/elements/Spinner";
import { Action } from "../../dispatcher/actions";
import { type ActionPayload } from "../../dispatcher/payloads";
import { showToast as showUpdateToast } from "../../toasts/UpdateToast";
import { type CheckUpdatesPayload } from "../../dispatcher/payloads/CheckUpdatesPayload";
import ToastStore from "../../stores/ToastStore";
import GenericExpiringToast from "../../components/views/toasts/GenericExpiringToast";
import { BreadcrumbsStore } from "../../stores/BreadcrumbsStore";
import { UPDATE_EVENT } from "../../stores/AsyncStore";
import { avatarUrlForRoom, getInitialLetter } from "../../Avatar";
import DesktopCapturerSourcePicker from "../../components/views/elements/DesktopCapturerSourcePicker";
import { MatrixClientPeg } from "../../MatrixClientPeg";
import { SeshatIndexManager } from "./SeshatIndexManager";
import { IPCManager } from "./IPCManager";
import { _t } from "../../languageHandler";
import { BadgeOverlayRenderer } from "../../favicon";
import GenericToast from "../../components/views/toasts/GenericToast.tsx";
import * as Avatar from "../../Avatar";
import DMRoomMap from "../../utils/DMRoomMap";
import SettingsStore from "../../settings/SettingsStore";

interface SquirrelUpdate {
    releaseNotes: string;
    releaseName: string;
    releaseDate: Date;
    updateURL: string;
}

const SSO_ID_KEY = "element-desktop-ssoid";

function platformFriendlyName(): string {
    // used to use window.process but the same info is available here
    if (navigator.userAgent.includes("Macintosh")) {
        return "macOS";
    } else if (navigator.userAgent.includes("FreeBSD")) {
        return "FreeBSD";
    } else if (navigator.userAgent.includes("OpenBSD")) {
        return "OpenBSD";
    } else if (navigator.userAgent.includes("SunOS")) {
        return "SunOS";
    } else if (navigator.userAgent.includes("Windows")) {
        return "Windows";
    } else if (navigator.userAgent.includes("Linux")) {
        return "Linux";
    } else {
        return "Unknown";
    }
}

function getUpdateCheckStatus(status: boolean | string): UpdateStatus {
    if (status === true) {
        return { status: UpdateCheckStatus.Downloading };
    } else if (status === false) {
        return { status: UpdateCheckStatus.NotAvailable };
    } else {
        return {
            status: UpdateCheckStatus.Error,
            detail: status,
        };
    }
}

export default class ElectronPlatform extends BasePlatform {
    private readonly ipc = new IPCManager("ipcCall", "ipcReply");
    private readonly eventIndexManager: BaseEventIndexManager = new SeshatIndexManager();
    public readonly initialised: Promise<void>;
    private readonly electron: Electron;
    private protocol!: string;
    private sessionId!: string;
    private badgeOverlayRenderer?: BadgeOverlayRenderer;
    private config!: IConfigOptions;
    private supportedSettings?: Record<string, boolean>;
    private clientStartedPromiseWithResolvers = Promise.withResolvers<void>();

    // Use custom in-app toast windows only on Windows (integrates nicely with Electron)
    private useCustomToasts(): boolean {
        return true; // TODO: Labs feat
    }

    public constructor() {
        super();

        if (!window.electron) {
            throw new Error("Cannot instantiate ElectronPlatform, window.electron is not set");
        }
        this.electron = window.electron;

        /*
            IPC Call `check_updates` returns:
            true if there is an update available
            false if there is not
            or the error if one is encountered
         */
        this.electron.on("check_updates", (event, status) => {
            dis.dispatch<CheckUpdatesPayload>({
                action: Action.CheckUpdates,
                ...getUpdateCheckStatus(status),
            });
        });

        // `userAccessToken` (IPC) is requested by the main process when appending authentication
        // to media downloads. A reply is sent over the same channel.
        this.electron.on("userAccessToken", () => {
            this.electron.send("userAccessToken", MatrixClientPeg.get()?.getAccessToken());
        });

        // `homeserverUrl` (IPC) is requested by the main process. A reply is sent over the same channel.
        this.electron.on("homeserverUrl", () => {
            this.electron.send("homeserverUrl", MatrixClientPeg.get()?.getHomeserverUrl());
        });

        this.electron.on("webBaseUrl", () => {
            this.electron.send("webBaseUrl", this.baseUrl);
        });

        this.electron.on("customToastClick", async (_ev, { roomId, eventId, nonce }) => {
            await this.clientStartedPromiseWithResolvers.promise;
            const payload: any = {
                action: Action.ViewRoom,
                room_id: roomId,
                metricsTrigger: "Notification",
            };
            if (eventId) payload.event_id = eventId;
            try {
                dis.dispatch(payload);
            } finally {
                // ACK back to main so it doesn't run its fallback navigation
                try { this.electron.send("customToastClickAck", nonce); } catch {}
                await this.ipc.call("focusWindow");
            }
        });

        // `serverSupportedVersions` is requested by the main process when it needs to know if the
        // server supports a particular version. This is primarily used to detect authenticated media
        // support. A reply is sent over the same channel.
        this.electron.on("serverSupportedVersions", async () => {
            this.electron.send("serverSupportedVersions", await MatrixClientPeg.get()?.getVersions());
        });

        // try to flush the rageshake logs to indexeddb before quit.
        this.electron.on("before-quit", function () {
            logger.log("element-desktop closing");
            rageshake.flush();
        });

        this.electron.on("update-downloaded", this.onUpdateDownloaded);

        this.electron.on("preferences", () => {
            dis.fire(Action.ViewUserSettings);
        });

        this.electron.on("userDownloadCompleted", (ev, { id, name }) => {
            const key = `DOWNLOAD_TOAST_${id}`;

            const onAccept = (): void => {
                this.electron.send("userDownloadAction", { id, open: true });
                ToastStore.sharedInstance().dismissToast(key);
            };

            const onDismiss = (): void => {
                this.electron.send("userDownloadAction", { id });
            };

            ToastStore.sharedInstance().addOrReplaceToast({
                key,
                title: _t("download_completed"),
                props: {
                    description: name,
                    primaryLabel: _t("action|open"),
                    onPrimaryClick: onAccept,
                    dismissLabel: _t("action|dismiss"),
                    onDismiss,
                    numSeconds: 10,
                },
                component: GenericExpiringToast,
                priority: 99,
            });
        });

        this.electron.on("openDesktopCapturerSourcePicker", async () => {
            const { finished } = Modal.createDialog(DesktopCapturerSourcePicker);
            const [source] = await finished;
            // getDisplayMedia promise does not return if no dummy is passed here as source
            await this.ipc.call("callDisplayMediaCallback", source ?? { id: "", name: "", thumbnailURL: "" });
        });

        this.electron.on("showToast", async (ev, { title, description, priority = 40 }) => {
            await this.clientStartedPromiseWithResolvers.promise;

            const key = uniqueId("electron_showToast_");
            const onPrimaryClick = (): void => {
                ToastStore.sharedInstance().dismissToast(key);
            };

            ToastStore.sharedInstance().addOrReplaceToast({
                key,
                title,
                props: {
                    description,
                    primaryLabel: _t("action|dismiss"),
                    onPrimaryClick,
                },
                component: GenericToast,
                priority,
            });
        });

        BreadcrumbsStore.instance.on(UPDATE_EVENT, this.onBreadcrumbsUpdate);

        this.initialised = this.initialise();
    }

    protected onAction(payload: ActionPayload): void {
        super.onAction(payload);
        // Whitelist payload actions, no point sending most across
        if (["call_state"].includes(payload.action)) {
            this.electron.send("app_onAction", payload);
        }

        if (payload.action === "client_started") {
            this.clientStartedPromiseWithResolvers.resolve();
        }
    }

    private async initialise(): Promise<void> {
        const { protocol, sessionId, config, supportedSettings, supportsBadgeOverlay } =
            await this.electron.initialise();
        this.protocol = protocol;
        this.sessionId = sessionId;
        this.config = config;
        this.supportedSettings = supportedSettings;
        if (supportsBadgeOverlay) {
            this.badgeOverlayRenderer = new BadgeOverlayRenderer();
        }
    }

    public async getConfig(): Promise<IConfigOptions | undefined> {
        await this.initialised;
        return this.config;
    }

    private onBreadcrumbsUpdate = (): void => {
        const rooms = BreadcrumbsStore.instance.rooms.slice(0, 7).map((r) => ({
            roomId: r.roomId,
            avatarUrl: avatarUrlForRoom(
                r,
                Math.floor(60 * window.devicePixelRatio),
                Math.floor(60 * window.devicePixelRatio),
                "crop",
            ),
            initial: getInitialLetter(r.name),
        }));
        void this.ipc.call("breadcrumbs", rooms);
    };

    private onUpdateDownloaded = async (ev: Event, { releaseNotes, releaseName }: SquirrelUpdate): Promise<void> => {
        dis.dispatch<CheckUpdatesPayload>({
            action: Action.CheckUpdates,
            status: UpdateCheckStatus.Ready,
        });
        if (this.shouldShowUpdate(releaseName)) {
            showUpdateToast(await this.getAppVersion(), releaseName, releaseNotes);
        }
    };

    private async showWindowsToastWithAvatar(
        title: string,
        msg: string,
        _avatarUrl: string | null, // not used here; we build our own avatar
        room: Room,
        ev?: MatrixEvent,
    ): Promise<void> {
        const eventId = ev?.getId();
        const launchArg =
            `element://room/${encodeURIComponent(room.roomId)}${eventId ? `/${encodeURIComponent(eventId)}` : ""}`;
        try {
            // If sender info is hidden, show brand and rely on app icon
            if (!SettingsStore.getValue("notificationSenderInfoEnabled")) {
                const brand = SdkConfig.get().brand || "Element";
                await this.ipc.call("winToast", { title: brand, body: msg, launchArg, avatarCandidates: [] });
                return;
            }

            // Try to match the UI: room avatar; for DMs use partner avatar if present
            let dataUrl: string | null = null;
            const uiUrl = Avatar.avatarUrlForRoom(room, 64, 64, "crop");
            if (uiUrl) {
                dataUrl = await this.fetchImageAsDataUrl(uiUrl);
            }

            // Fallback to a letter avatar (rendered to data:) like the UI
            if (!dataUrl) {
                const { key, name } = this.getLetterAvatarKeyAndName(room);
                dataUrl = await this.renderLetterAvatarDataUrl(name, key, 64);
            }
            await this.ipc.call("winToast", { title, body: msg, launchArg, avatarCandidates: [dataUrl] });

        } catch (e) {
            console.error("[ElectronPlatform] winToast IPC failed", e);
            super.displayNotification(title, msg, `${this.baseUrl}/favicon.ico`, room);
        }
    }

    private async showCustomToast(
        title: string,
        msg: string,
        _avatarUrl: string | null,
        room: Room,
        ev?: MatrixEvent,
    ): Promise<void> {
        try {
            // Respect setting that hides sender info/avatar
            const showInfo = SettingsStore.getValue("notificationSenderInfoEnabled");

            let dataUrl: string | null = null;
            if (showInfo) {
                // Match the UI for avatar: DM partner or room; fallback to letter avatar
                const uiUrl = Avatar.avatarUrlForRoom(room, 64, 64, "crop");
                if (uiUrl) {
                    dataUrl = await this.fetchImageAsDataUrl(uiUrl);
                }
                if (!dataUrl) {
                    const { key, name } = this.getLetterAvatarKeyAndName(room);
                    dataUrl = await this.renderLetterAvatarDataUrl(name, key, 64);
                }
            }

            await this.ipc.call("customToast", {
                // If info is hidden, use brand as title (same as system toast)
                title: showInfo ? title : (SdkConfig.get().brand || "Element"),
                body: msg,
                // Important: don't send avatar when info is hidden
                avatar: showInfo ? dataUrl : null,
                roomId: room.roomId,
                eventId: ev?.getId() ?? null,
                showInfo, // explicit flag for main process
            });
        } catch (e) {
            console.warn("[toast] customToast failed, fallback to system", e);
            super.displayNotification(title, msg, `${this.baseUrl}/favicon.ico`, room, ev);
        }
    }

    private getLetterAvatarKeyAndName(room: Room): { key: string; name: string } {
        const dm = this.getDmPartnerUserId(room);
        if (dm) {
            const name = room.getMember(dm)?.name || dm;
            return { key: dm, name };
        }
        return { key: room.roomId || room.name || "#", name: room.name || "#" };
    }

    private async renderLetterAvatarDataUrl(name: string, key: string, size = 64): Promise<string> {
        // Build backgrounds/colors using the same helpers as the UI
        const bgUrl     = Avatar.defaultAvatarUrlForString(key);
        const textColor = Avatar.getAvatarTextColor(key);
        const initial   = (Avatar.getInitialLetter(name) || "?").toUpperCase();

        // Try to wait for fonts (Compound), but don't block forever
        try { await Promise.race([document.fonts?.ready ?? Promise.resolve(), new Promise(r => setTimeout(r, 120))]); } catch {}
        const themed = getComputedStyle(document.documentElement).getPropertyValue("--cpd-font-family").trim();
        const body   = getComputedStyle(document.body).fontFamily || "";
        const fontFamily = themed || body || `"Inter","Inter var",system-ui,"Segoe UI",Arial,sans-serif`;
        const fontWeight = 600;
        const fontSize   = Math.floor(size * 0.56); // как в UI

        const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
        const canvas = document.createElement("canvas");
        canvas.width = size * dpr;
        canvas.height = size * dpr;
        const ctx = canvas.getContext("2d")!;
        ctx.scale(dpr, dpr);

        // Background (same data: the UI would generate)
        await new Promise<void>((resolve) => {
            const img = new Image();
            img.onload = () => { ctx.drawImage(img, 0, 0, size, size); resolve(); };
            img.onerror = () => resolve(); // без фона не падаем
            img.src = bgUrl || "";
        });

        // Center the letter using real text metrics
        ctx.fillStyle = textColor;
        ctx.textAlign = "center";
        ctx.textBaseline = "alphabetic";
        ctx.font = `${fontWeight} ${fontSize}px ${fontFamily}`;

        const m = ctx.measureText(initial);
        const ascent  = m.actualBoundingBoxAscent  ?? fontSize * 0.8;
        const descent = m.actualBoundingBoxDescent ?? fontSize * 0.2;
        const y = (size - (ascent + descent)) / 2 + ascent;

        ctx.fillText(initial, size / 2, y);
        return canvas.toDataURL("image/png");
    }

    // Fetch an image (add Bearer for Matrix media), convert to data: URL.
    // Returns null on failure.
    private async fetchImageAsDataUrl(url?: string | null): Promise<string | null> {
        if (!url) return null;
        if (url.startsWith("data:")) return url;

        try {
            const headers: Record<string, string> = {};
            // Add token for Matrix media / media_proxy, like the client does
            if (/_matrix\/media(\/|_proxy\/)/.test(url)) {
                const token = MatrixClientPeg.get()?.getAccessToken();
                if (token) headers.Authorization = `Bearer ${token}`;
            }

            const res = await fetch(url, { headers, credentials: "omit" });
            if (!res.ok) return null;

            const blob = await res.blob();
            // blob -> data:
            const dataUrl = await new Promise<string>((resolve, reject) => {
                const fr = new FileReader();
                fr.onload = () => {
                    const val = fr.result;
                    if (typeof val === "string") {
                        resolve(val);
                    } else {
                        reject(new Error("Unexpected FileReader result type"));
                    }
                };
                fr.onerror = () => reject(fr.error ?? new Error("FileReader failed"));
                fr.readAsDataURL(blob);
            });
            return dataUrl;
        } catch {
            return null;
        }
    }

    private getDmPartnerUserId(room: Room): string | undefined {
        try {
            return DMRoomMap.shared().getUserIdForRoomId?.(room.roomId) ?? undefined;
        } catch {
            return undefined;
        }
    }

    public getHumanReadableName(): string {
        return "Electron Platform"; // no translation required: only used for analytics
    }

    /**
     * Return true if platform supports multi-language
     * spell-checking, otherwise false.
     */
    public supportsSpellCheckSettings(): boolean {
        return true;
    }

    public allowOverridingNativeContextMenus(): boolean {
        return true;
    }

    public setNotificationCount(count: number): void {
        if (this.notificationCount === count) return;
        super.setNotificationCount(count);
        if (this.badgeOverlayRenderer) {
            this.badgeOverlayRenderer
                .render(count)
                .then((buffer) => {
                    this.electron.send("setBadgeCount", count, buffer);
                })
                .catch((ex) => {
                    logger.warn("Unable to generate badge overlay", ex);
                });
        } else {
            this.electron.send("setBadgeCount", count);
        }
    }

    public setErrorStatus(errorDidOccur: boolean): void {
        if (!this.badgeOverlayRenderer) {
            super.setErrorStatus(errorDidOccur);
            return;
        }
        // Check before calling super so we don't override the previous state.
        if (this.errorDidOccur !== errorDidOccur) {
            super.setErrorStatus(errorDidOccur);
            let promise: Promise<ArrayBuffer | null>;
            if (errorDidOccur) {
                promise = this.badgeOverlayRenderer.render(this.notificationCount || "×", "#f00");
            } else {
                promise = this.badgeOverlayRenderer.render(this.notificationCount);
            }
            promise
                .then((buffer) => {
                    this.electron.send("setBadgeCount", this.notificationCount, buffer, errorDidOccur);
                })
                .catch((ex) => {
                    logger.warn("Unable to generate badge overlay", ex);
                });
        }
    }

    public supportsNotifications(): boolean {
        return true;
    }

    public maySendNotifications(): boolean {
        return true;
    }

    public displayNotification(
        title: string,
        msg: string,
        avatarUrl: string,
        room: Room,
        ev?: MatrixEvent,
    ): Notification {
        // Policy: if sender info is hidden, use brand and app icon
        if (!SettingsStore.getValue("notificationSenderInfoEnabled")) {
            title = SdkConfig.get().brand || "Element";
            // Could be null, but favicon gives a consistent look
            avatarUrl = `${this.baseUrl}/favicon.ico`;
        }

        // GNOME notification spec parses HTML tags for styling...
        // Electron Docs state all supported linux notification systems follow this markup spec
        // https://github.com/electron/electron/blob/master/docs/tutorial/desktop-environment-integration.md#linux
        // maybe we should pass basic styling (italics, bold, underline) through from MD
        // we only have to strip out < and > as the spec doesn't include anything about things like &amp;
        // so we shouldn't assume that all implementations will treat those properly. Very basic tag parsing is done.
        if (navigator.userAgent.includes("Linux")) {
            msg = msg.replace(/</g, "&lt;").replace(/>/g, "&gt;");
        }

        if (navigator.userAgent.includes("Windows")) {
            if (this.useCustomToasts()) {
                void this.showCustomToast(title, msg, avatarUrl || null, room, ev);
            } else {
                void this.showWindowsToastWithAvatar(title, msg, avatarUrl || null, room, ev);
            }
            return undefined as unknown as Notification;
        }

        const notification = super.displayNotification(title, msg, avatarUrl, room, ev);

        const handler = notification.onclick as () => void;
        notification.onclick = (): void => {
            handler?.();
            void this.ipc.call("focusWindow");
        };

        return notification;
    }

    public loudNotification(ev: MatrixEvent, room: Room): void {
        this.electron.send("loudNotification");
    }

    public needsUrlTooltips(): boolean {
        return true;
    }

    public async getAppVersion(): Promise<string> {
        return this.ipc.call("getAppVersion");
    }

    public supportsSetting(settingName?: string): boolean {
        if (settingName === undefined) return true;
        return this.supportedSettings?.[settingName] === true;
    }

    public async getSettingValue(settingName: string): Promise<any> {
        await this.initialised;
        return this.electron.getSettingValue(settingName);
    }

    public async setSettingValue(settingName: string, value: any): Promise<void> {
        await this.initialised;
        return this.electron.setSettingValue(settingName, value);
    }

    public async canSelfUpdate(): Promise<boolean> {
        const feedUrl = await this.ipc.call("getUpdateFeedUrl");
        return Boolean(feedUrl);
    }

    public startUpdateCheck(): void {
        super.startUpdateCheck();
        this.electron.send("check_updates");
    }

    public installUpdate(): void {
        // IPC to the main process to install the update, since quitAndInstall
        // doesn't fire the before-quit event so the main process needs to know
        // it should exit.
        this.electron.send("install_update");
    }

    public getDefaultDeviceDisplayName(): string {
        const brand = SdkConfig.get().brand;
        return _t("desktop_default_device_name", {
            brand,
            platformName: platformFriendlyName(),
        });
    }

    public requestNotificationPermission(): Promise<string> {
        return Promise.resolve("granted");
    }

    public reload(): void {
        window.location.reload();
    }

    public getEventIndexingManager(): BaseEventIndexManager | null {
        return this.eventIndexManager;
    }

    public async setLanguage(preferredLangs: string[]): Promise<any> {
        return this.ipc.call("setLanguage", preferredLangs);
    }

    public setSpellCheckEnabled(enabled: boolean): void {
        this.ipc.call("setSpellCheckEnabled", enabled).catch((error) => {
            logger.log("Failed to send setSpellCheckEnabled IPC to Electron");
            logger.error(error);
        });
    }

    public async getSpellCheckEnabled(): Promise<boolean> {
        return this.ipc.call("getSpellCheckEnabled");
    }

    public setSpellCheckLanguages(preferredLangs: string[]): void {
        this.ipc.call("setSpellCheckLanguages", preferredLangs).catch((error) => {
            logger.log("Failed to send setSpellCheckLanguages IPC to Electron");
            logger.error(error);
        });
    }

    public async getSpellCheckLanguages(): Promise<string[]> {
        return this.ipc.call("getSpellCheckLanguages");
    }

    public async getDesktopCapturerSources(options: GetSourcesOptions): Promise<Array<DesktopCapturerSource>> {
        return this.ipc.call("getDesktopCapturerSources", options);
    }

    public supportsDesktopCapturer(): boolean {
        return true;
    }

    public supportsJitsiScreensharing(): boolean {
        // See https://github.com/element-hq/element-web/issues/4880
        return false;
    }

    public async getAvailableSpellCheckLanguages(): Promise<string[]> {
        return this.ipc.call("getAvailableSpellCheckLanguages");
    }

    public getSSOCallbackUrl(fragmentAfterLogin?: string): URL {
        const url = super.getSSOCallbackUrl(fragmentAfterLogin);
        url.protocol = "element";
        url.searchParams.set(SSO_ID_KEY, this.sessionId);
        return url;
    }

    public startSingleSignOn(
        mxClient: MatrixClient,
        loginType: "sso" | "cas",
        fragmentAfterLogin: string,
        idpId?: string,
    ): void {
        // this will get intercepted by electron-main will-navigate
        super.startSingleSignOn(mxClient, loginType, fragmentAfterLogin, idpId);
        Modal.createDialog(InfoDialog, {
            title: _t("auth|sso_complete_in_browser_dialog_title"),
            description: <Spinner />,
        });
    }

    public navigateForwardBack(back: boolean): void {
        void this.ipc.call(back ? "navigateBack" : "navigateForward");
    }

    public overrideBrowserShortcuts(): boolean {
        return true;
    }

    public async getPickleKey(userId: string, deviceId: string): Promise<string | null> {
        try {
            return await this.ipc.call("getPickleKey", userId, deviceId);
        } catch {
            // if we can't connect to the password storage, assume there's no
            // pickle key
            return null;
        }
    }

    public async createPickleKey(userId: string, deviceId: string): Promise<string | null> {
        try {
            return await this.ipc.call("createPickleKey", userId, deviceId);
        } catch {
            // if we can't connect to the password storage, assume there's no
            // pickle key
            return null;
        }
    }

    public async destroyPickleKey(userId: string, deviceId: string): Promise<void> {
        try {
            await this.ipc.call("destroyPickleKey", userId, deviceId);
        } catch {}
    }

    public async clearStorage(): Promise<void> {
        try {
            await super.clearStorage();
            await this.ipc.call("clearStorage");
        } catch {}
    }

    public get baseUrl(): string {
        // This configuration is element-desktop specific so the types here do not know about it
        return (SdkConfig.get() as unknown as Record<string, string>)["web_base_url"] ?? "https://app.element.io";
    }

    public get defaultOidcClientUri(): string {
        // Default to element.io as our scheme `io.element.desktop` is within its scope on default MAS policies
        return "https://element.io";
    }

    public async getOidcClientMetadata(): Promise<OidcRegistrationClientMetadata> {
        const baseMetadata = await super.getOidcClientMetadata();
        return {
            ...baseMetadata,
            applicationType: "native",
        };
    }

    public getOidcClientState(): string {
        return `:${SSO_ID_KEY}:${this.sessionId}`;
    }

    /**
     * The URL to return to after a successful OIDC authentication
     */
    public getOidcCallbackUrl(): URL {
        const url = super.getOidcCallbackUrl();
        url.protocol = this.protocol;
        // Trim the double slash into a single slash to comply with https://datatracker.ietf.org/doc/html/rfc8252#section-7.1
        if (url.href.startsWith(`${url.protocol}//`)) {
            url.href = url.href.replace("://", ":/");
        }
        return url;
    }

    public checkSessionLockFree(): boolean {
        return true;
    }

    public async getSessionLock(_onNewInstance: () => Promise<void>): Promise<boolean> {
        return true;
    }
}
