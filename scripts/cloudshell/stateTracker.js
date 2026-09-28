/**
 * File: scripts/cloudshell/stateTracker.js
 * Description: Atomic runtime state persistence and terminal status formatter for Cloud Shell
 */

const fs = require("fs");
const path = require("path");

const formatDuration = seconds => {
    if (seconds < 0 || Number.isNaN(seconds)) return "0s";
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    const parts = [];
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0 || hours > 0) parts.push(`${minutes}m`);
    parts.push(`${secs}s`);
    return parts.join(" ");
};

class StateTracker {
    constructor(stateFilePath) {
        this.stateFilePath = stateFilePath || path.join(process.cwd(), "logs", "cloudshell", "state.json");
        this.flagFilePath = path.join(path.dirname(this.stateFilePath), "paused.flag");
    }

    isPaused() {
        try {
            return fs.existsSync(this.flagFilePath);
        } catch {
            return false;
        }
    }

    setPaused(paused) {
        const isPaused = Boolean(paused);
        this.saveState({ antiDetectionPaused: isPaused });

        const dir = path.dirname(this.flagFilePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        if (isPaused) {
            fs.writeFileSync(this.flagFilePath, new Date().toISOString(), "utf-8");
        } else if (fs.existsSync(this.flagFilePath)) {
            fs.unlinkSync(this.flagFilePath);
        }

        return isPaused;
    }

    loadState() {
        try {
            if (!fs.existsSync(this.stateFilePath)) {
                return null;
            }
            const content = fs.readFileSync(this.stateFilePath, "utf-8");
            return JSON.parse(content);
        } catch {
            return null;
        }
    }

    saveState(partialData = {}) {
        const current = this.loadState() || {};
        const updated = {
            ...current,
            ...partialData,
            updatedAt: new Date().toISOString(),
        };

        const dir = path.dirname(this.stateFilePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        const tempFile = `${this.stateFilePath}.tmp.${process.pid}.${Date.now()}`;
        fs.writeFileSync(tempFile, JSON.stringify(updated, null, 2), "utf-8");
        fs.renameSync(tempFile, this.stateFilePath);

        return updated;
    }

    clearState() {
        try {
            if (fs.existsSync(this.stateFilePath)) {
                fs.unlinkSync(this.stateFilePath);
            }
        } catch {
            // Ignore removal errors
        }
        try {
            if (fs.existsSync(this.flagFilePath)) {
                fs.unlinkSync(this.flagFilePath);
            }
        } catch {
            // Ignore removal errors
        }
    }

    formatStatusOutput(state, isAlive) {
        if (!state || !isAlive) {
            const lastPid = state && state.pid ? ` (Last PID: ${state.pid})` : "";
            return [
                "==================================================",
                `Cloud Shell Status: Stopped${lastPid}`,
                "==================================================",
            ].join("\n");
        }

        let uptimeStr = "N/A";
        if (state.startedAt) {
            const diffSeconds = Math.max(0, Math.floor((Date.now() - new Date(state.startedAt).getTime()) / 1000));
            uptimeStr = formatDuration(diffSeconds);
        }

        const isPaused = Boolean(state.antiDetectionPaused);
        const autoRotationStr = isPaused
            ? "⏸️ Paused"
            : `▶️ Active (Every ${state.switchIntervalMinutes ? `${state.switchIntervalMinutes} min` : "N/A"})`;

        const lines = [
            "==================================================",
            `Cloud Shell Status: Running (PID: ${state.pid})`,
            `Anti-Detection:     ${isPaused ? "⏸️ Paused (Manual Mode)" : "▶️ Active (Enabled)"}`,
            `Auto-Rotation:      ${autoRotationStr}`,
            `Started At:         ${state.startedAt || "N/A"}`,
            `Uptime:             ${uptimeStr}`,
            `Switch Interval:    ${state.switchIntervalMinutes ? `${state.switchIntervalMinutes} min` : "N/A"}`,
            `Current Active:     Auth ${state.currentAuthIndex !== undefined ? state.currentAuthIndex : "N/A"}`,
            "--------------------------------------------------",
            "Accounts:",
        ];

        if (Array.isArray(state.accounts) && state.accounts.length > 0) {
            for (const acc of state.accounts) {
                const statusStr = acc.status
                    ? acc.status.charAt(0).toUpperCase() + acc.status.slice(1).toLowerCase()
                    : "Unknown";
                const isCurrent = acc.authIndex === state.currentAuthIndex;
                const marker = isCurrent ? "* " : "  ";
                const nameStr = acc.accountName || `auth-${acc.authIndex}.json`;
                const hbStr = acc.lastHeartbeatAt ? `(Heartbeat: ${acc.lastHeartbeatAt})` : "";
                lines.push(`${marker}[Auth ${acc.authIndex}] ${nameStr} | Status: ${statusStr} ${hbStr}`.trimEnd());
            }
        } else {
            lines.push("  No accounts recorded");
        }

        lines.push("==================================================");
        return lines.join("\n");
    }
}

module.exports = {
    StateTracker,
};
