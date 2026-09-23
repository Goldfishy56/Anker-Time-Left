// Shown in the app under "What's new". Newest first; the first entry's
// version is the app version shown in the footer.
export const CHANGELOG = [
  {
    version: 11,
    date: "2026-09-23",
    changes: [
      "Fixed: taking the bank off the charging base left \"until full\" running and counting up. When charging stops the bank marks its input as off but keeps sending the last wattage; the app now respects the off flag.",
      "Charging starting or stopping now switches the display within about 2 seconds, instead of waiting for the 3-minute average to catch up.",
    ],
  },
  {
    version: 10,
    date: "2026-09-23",
    changes: [
      "Prime charging base: charging on the base shows as \"until full\" like a cable, because the app reads the bank's own input total.",
      "A bank sitting on its charger at 100 % now shows \"Full\" (plus any power it's passing through to your devices) instead of \"Nothing is drawing power\".",
      "If the charger exactly covers what your devices draw, it shows \"Holding\" instead of a countdown.",
      "The charger row in the port list is now called \"Charging input\", since it covers both the base and a cable.",
    ],
  },
  {
    version: 9,
    date: "2026-09-23",
    changes: [
      "Charging now detected: your log showed the bank reports its charger input separately from the USB ports. The app now reads the bank's own input and output totals, and shows the charger (volts, amps, watts) in the port list.",
      "While charging, the countdown uses the bank's own time-to-full estimate.",
      "Battery is now read to 0.01 % (the bank sends hundredths), so the charge level and estimate are much more precise.",
      "Disconnects: both of your logs show the bank sending one message about 30 seconds in and hanging up at 58 seconds when the app doesn't answer. The app now replies to it.",
    ],
  },
  {
    version: 8,
    date: "2026-09-23",
    changes: [
      "Charging detection: readings with a port status the app didn't recognise were thrown away, which could freeze the screen while charging. They're now kept, and a port with power flowing that isn't marked as an output is treated as charging the bank.",
      "The bank's total-power figure is no longer counted as output when a port is in use, since it may include charging power.",
      "Debug log shows voltage and the bank's total power for every reading, to help pin down how this bank reports charging.",
    ],
  },
  {
    version: 7,
    date: "2026-09-23",
    changes: [
      "Your debug log showed the bank hangs up after about 60 seconds if the app stays silent. The app now sends a status request every 20 seconds, which the bank answers, to keep the connection open.",
      "Messages the bank sends unencrypted (such as its status reply) are now read correctly instead of being decrypted into garbage.",
      "Brief reconnects no longer mark the estimate as \"last known\"; that only shows after 15 seconds offline.",
    ],
  },
  {
    version: 6,
    date: "2026-09-23",
    changes: [
      "The countdown now ticks down smoothly one second at a time and eases into new estimates instead of jumping 30-60 seconds.",
      "The average is now weighted by time. The bank only sends a reading when something changes, so bursts of readings no longer skew it.",
      "Stopped sending the bank anything after connecting (no keep-alive or re-subscribe), to test whether one of those caused the disconnects. It didn't: see version 7.",
      "Debug log keeps more history and notes, at each disconnect, how long before it the app last sent or received data.",
    ],
  },
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
      "Sends a keep-alive to the bank every 9 seconds, which should stop the drop-and-reconnect about once a minute. (Removed in version 6: it didn't help.)",
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
