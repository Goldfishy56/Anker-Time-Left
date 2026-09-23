// Shown in the app under "What's new". Newest first; the first entry's
// version is the app version shown in the footer.
export const CHANGELOG = [
  {
    version: 5,
    date: "2026-09-23",
    changes: [
      "Added this change log. It opens by itself the first time you load a new version.",
    ],
  },
  {
    version: 4,
    date: "2026-09-23",
    changes: [
      "Sends a keep-alive to the bank every 9 seconds, which should stop the drop-and-reconnect about once a minute.",
      "A reconnect no longer restarts the 3-minute average; the countdown carries on through short dropouts.",
      "The learned battery capacity survives reconnects of up to 2 minutes.",
      "Debug log shows how long each connection stayed live.",
    ],
  },
  {
    version: 3,
    date: "2026-09-23",
    changes: [
      "Version number shown at the bottom of the page.",
      "Updates now always load fresh files instead of cached old ones.",
    ],
  },
  {
    version: 2,
    date: "2026-09-23",
    changes: [
      "Much steadier estimate: power draw is averaged over the last 3 minutes instead of jumping with every reading.",
      "A real change in load (plugging in or unplugging) is still picked up in about 30 seconds.",
      "Bad or incomplete readings from the bank are ignored instead of counted as 0 W.",
      "Debug log shows every reading from the bank.",
    ],
  },
  {
    version: 1,
    date: "2026-09-23",
    changes: [
      "First version: live time until empty (or until full while charging) for the Anker Prime 20K 220W over Bluetooth.",
      "Battery %, watts in and out, temperature and per-port readings.",
      "Learns your bank's real capacity as it drains. Demo mode, settings and debug log.",
    ],
  },
];

export const APP_VERSION = CHANGELOG[0].version;
