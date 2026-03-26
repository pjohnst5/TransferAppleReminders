// Transfer Apple Reminders - Obsidian Plugin
// Transfers incomplete Apple Reminders into Daily Notes on startup.

const obsidian = require("obsidian");
const fs = require("fs");
const path = require("path");
const { exec, execSync } = require("child_process");

const MONTH_NAMES = [
	"January", "February", "March", "April", "May", "June",
	"July", "August", "September", "October", "November", "December"
];

const DAY_NAMES = [
	"Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"
];

// --- Daily note path generation ---
// Pattern: YYYY/MM-MMMM/YYYY-MM-DD-dddd.md

function dailyNotePath(dt) {
	const year = dt.getFullYear().toString();
	const monthNum = String(dt.getMonth() + 1).padStart(2, "0");
	const monthName = MONTH_NAMES[dt.getMonth()];
	const dayNum = String(dt.getDate()).padStart(2, "0");
	const dayName = DAY_NAMES[dt.getDay()];
	const folder = `${year}/${monthNum}-${monthName}`;
	const filename = `${year}-${monthNum}-${dayNum}-${dayName}.md`;
	return `${folder}/${filename}`;
}

// --- Trigger Reminders sync ---

function triggerRemindersSync() {
	return new Promise((resolve) => {
		exec('open -g -a "/System/Applications/Reminders.app"', (err) => {
			if (err) {
				console.log("Transfer Apple Reminders: Could not launch Reminders app", err);
			}
			setTimeout(resolve, 5000);
		});
	});
}

// --- Fetch incomplete reminders via JXA ---

function fetchReminders() {
	try {
		const os = require("os");
		const scriptPath = path.join(os.tmpdir(), "obsidian-fetch-reminders.js");
		const jxa = [
			'var app = Application("Reminders");',
			"var results = [];",
			"var lists = app.lists();",
			"for (var i = 0; i < lists.length; i++) {",
			"  var list = lists[i];",
			"  var rems = list.reminders.whose({completed: false})();",
			"  for (var j = 0; j < rems.length; j++) {",
			"    var r = rems[j];",
			"    var obj = {name: r.name()};",
			"    try { var d = r.dueDate(); if (d) obj.dueDate = d.toISOString(); } catch(e) {}",
			"    results.push(obj);",
			"  }",
			"}",
			"JSON.stringify(results);",
		].join("\n");
		fs.writeFileSync(scriptPath, jxa);
		const output = execSync(`osascript -l JavaScript "${scriptPath}" 2>/dev/null`, {
			encoding: "utf-8",
			timeout: 15000,
		});
		try { fs.unlinkSync(scriptPath); } catch {}
		return JSON.parse(output.trim());
	} catch (e) {
		console.error("Transfer Apple Reminders: Failed to fetch reminders", e);
		return [];
	}
}

const DAILY_NOTE_TEMPLATE_PATH = "Other/Templates/Daily Notes.md";

// --- Delete all incomplete reminders from Apple Reminders via JXA ---

function deleteAllReminders() {
	try {
		const os = require("os");
		const scriptPath = path.join(os.tmpdir(), "obsidian-delete-reminders.js");
		const jxa = [
			'var app = Application("Reminders");',
			"var lists = app.lists();",
			"var count = 0;",
			"for (var i = 0; i < lists.length; i++) {",
			"  var rems = lists[i].reminders.whose({completed: false})();",
			"  for (var j = rems.length - 1; j >= 0; j--) {",
			"    app.delete(rems[j]);",
			"    count++;",
			"  }",
			"}",
			"JSON.stringify({deleted: count});",
		].join("\n");
		fs.writeFileSync(scriptPath, jxa);
		const output = execSync(`osascript -l JavaScript "${scriptPath}" 2>/dev/null`, {
			encoding: "utf-8",
			timeout: 15000,
		});
		try { fs.unlinkSync(scriptPath); } catch {}
		const result = JSON.parse(output.trim());
		console.log(`Transfer Apple Reminders: Deleted ${result.deleted} reminders from Apple Reminders.`);
	} catch (e) {
		console.error("Transfer Apple Reminders: Failed to delete reminders", e);
	}
}

// --- Plugin ---

class TransferAppleRemindersPlugin extends obsidian.Plugin {
	async onload() {
		this.app.workspace.onLayoutReady(() => {
			this.syncThenTransfer();
		});
	}

	async syncThenTransfer() {
		await triggerRemindersSync();
		await this.transferReminders();
		try { execSync('osascript -e \'quit app "Reminders"\''); } catch {}
	}

	async transferReminders() {
		const reminders = fetchReminders();
		if (reminders.length === 0) {
			console.log("Transfer Apple Reminders: No incomplete reminders found.");
			return;
		}

		// Group by target date (due date or today)
		const today = new Date();
		const byDate = {};
		for (const r of reminders) {
			let targetDate = today;
			if (r.dueDate) {
				const d = new Date(r.dueDate);
				if (!isNaN(d.getTime())) targetDate = d;
			}
			const notePath = dailyNotePath(targetDate);
			if (!byDate[notePath]) byDate[notePath] = [];
			byDate[notePath].push(r.name);
		}

		let totalAdded = 0;

		for (const [notePath, names] of Object.entries(byDate)) {
			let file = this.app.vault.getAbstractFileByPath(notePath);

			if (!file) {
				// Create daily note from template
				const folderPath = notePath.substring(0, notePath.lastIndexOf("/"));
				await this.ensureFolderExists(folderPath);
				let template = "";
				const tplFile = this.app.vault.getAbstractFileByPath(DAILY_NOTE_TEMPLATE_PATH);
				if (tplFile && tplFile instanceof obsidian.TFile) {
					template = await this.app.vault.read(tplFile);
				}
			if (!template) template = "## Todo\n- [ ] \n";
				await this.app.vault.create(notePath, template);
				file = this.app.vault.getAbstractFileByPath(notePath);
			}

			if (file && file instanceof obsidian.TFile) {
				const added = await this.mergeRemindersIntoNote(file, names);
				totalAdded += added;
			}
		}

		if (totalAdded > 0) {
			new obsidian.Notice(`Reminders: ${totalAdded} imported.`);
		}
		console.log(`Transfer Apple Reminders: ${totalAdded} reminders added, ${reminders.length} total incomplete.`);

		// Delete all incomplete reminders from Apple Reminders now that they're in Obsidian
		deleteAllReminders();
	}

	async mergeRemindersIntoNote(file, names) {
		let content = await this.app.vault.read(file);

		// Collect existing checklist item names in ## Todo section
		const existingNames = new Set();
		const headingMatch = content.match(/^## Todo\s*$/m);
		let sectionStart = -1;
		let sectionEnd = -1;

		if (headingMatch) {
			sectionStart = headingMatch.index + headingMatch[0].length;
			const rest = content.substring(sectionStart);
			const nextH = rest.search(/^## /m);
			sectionEnd = nextH === -1 ? content.length : sectionStart + nextH;
			const section = content.substring(sectionStart, sectionEnd);
			for (const line of section.split("\n")) {
				const m = line.match(/^- \[[ x]\] (.+?)(?:\s+_\(.*?\)_)?\s*$/);
				if (m) existingNames.add(m[1].trim());
			}
		}

		const toAdd = names.filter((n) => !existingNames.has(n));
		if (toAdd.length === 0) return 0;

		const newLines = toAdd.map((n) => `- [ ] ${n}`);

		if (headingMatch) {
			// Insert after the last checklist item in the section
			const sectionContent = content.substring(sectionStart, sectionEnd);
			const sectionLines = sectionContent.split("\n");
			let lastCheckIdx = -1;
			for (let k = sectionLines.length - 1; k >= 0; k--) {
				if (/^- \[[ x]\] .+/.test(sectionLines[k])) {
					lastCheckIdx = k;
					break;
				}
			}
			if (lastCheckIdx !== -1) {
				sectionLines.splice(lastCheckIdx + 1, 0, ...newLines);
			} else {
				// No non-empty checklist items — insert right after heading
				const firstNonEmpty = sectionLines.findIndex((l, i) => i > 0 && l.trim() !== "");
				const insertAt = firstNonEmpty !== -1 ? firstNonEmpty : sectionLines.length;
				sectionLines.splice(insertAt, 0, ...newLines);
			}
			// Remove empty checklist placeholders (e.g. "- [ ] " with no text)
			const filtered = sectionLines.filter((l) => !/^- \[[ x]\]\s*$/.test(l));
			content = content.substring(0, sectionStart) + filtered.join("\n") + content.substring(sectionEnd);
		} else {
			// No ## Todo section — prepend one
			content = "## Todo\n\n" + newLines.join("\n") + "\n\n" + content;
		}

		await this.app.vault.modify(file, content);
		return toAdd.length;
	}

	async ensureFolderExists(folderPath) {
		const parts = folderPath.split("/");
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			const existing = this.app.vault.getAbstractFileByPath(current);
			if (!existing) {
				await this.app.vault.createFolder(current);
			}
		}
	}
}

module.exports = TransferAppleRemindersPlugin;
