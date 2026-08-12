/* Watch schedule + progress calculator (client-side, no server round-trip).
 * Supports MULTIPLE playlists: #playlist-data may contain either a single
 * playlist object or an ARRAY of playlist objects. When it's an array, a
 * <select id="sched-playlist"> is used to switch between them (one is
 * created automatically if it isn't present in the markup) — including an
 * extra "All Playlists (Combined)" option that merges every playlist into
 * one continuous schedule for overall planning. Each selection (each
 * individual playlist, and the combined view) keeps its own "watched"
 * count in memory while you switch back and forth. The daily plan table
 * is capped to MAX_PLAN_ROWS rows by default, with a button (#sched-plan-more)
 * to expand and show every remaining day, or collapse back down.
 */
(function () {
  "use strict";

  var dataEl = document.getElementById("playlist-data");
  var rawData = null;
  if (dataEl) {
    try {
      rawData = JSON.parse(dataEl.textContent);
    } catch (e) {
      rawData = null;
    }
  }

  // Normalize to an array of playlists so the rest of the code only
  // ever deals with playlists[i].
  var playlists = Array.isArray(rawData) ? rawData : rawData ? [rawData] : [];
  var COMBINED_KEY = "combined";
  var currentSelection = "0"; // string: matches <option value>, either an index or COMBINED_KEY

  var elHours = document.getElementById("sched-hours");
  var elMinutes = document.getElementById("sched-minutes");
  var elSpeed = document.getElementById("sched-speed");
  var elStartToday = document.getElementById("sched-start-today");
  var elRing = document.getElementById("sched-ring");
  var elPct = document.getElementById("sched-pct");
  var elVideos = document.getElementById("sched-videos");
  var elDate = document.getElementById("sched-date");
  var elDays = document.getElementById("sched-days");
  var elWatched = document.getElementById("sched-watched");
  var elRemaining = document.getElementById("sched-remaining");
  var elTotal = document.getElementById("sched-total");
  var elEmpty = document.getElementById("schedule-empty");
  var elPlanCard = document.getElementById("sched-plan");
  var elPlanBody = document.getElementById("sched-plan-body");
  var elPlanMore = document.getElementById("sched-plan-more");
  var watchedInput = document.querySelector('input[name="watched_count"]');
  var elPlaylistSelect = document.getElementById("sched-playlist");

  if (!elRing || !elPct) return;

  var dayChecks = Array.prototype.slice.call(
    document.querySelectorAll(".sched-day"),
  );

  var CIRC = 2 * Math.PI * 52;
  var MAX_PLAN_ROWS = 21;
  elRing.setAttribute("stroke-dasharray", CIRC.toFixed(2));

  // Remembers how many videos are "watched" for each selection (each
  // playlist index, and the combined view) while you switch around.
  var watchedBySelection = {};

  var combinedPlaylistCache = null;

  // Plan table expand/collapse state — the full (uncapped) plan is always
  // computed; only rendering is limited to MAX_PLAN_ROWS until expanded.
  var planExpanded = false;
  var lastPlanRows = [];
  var lastPlanLabels = null;

  function formatDuration(seconds) {
    seconds = Math.max(0, Math.round(seconds));
    var d = Math.floor(seconds / 86400);
    seconds -= d * 86400;
    var h = Math.floor(seconds / 3600);
    seconds -= h * 3600;
    var m = Math.floor(seconds / 60);
    var s = seconds - m * 60;
    var parts = [];
    if (d) parts.push(d + "d");
    if (h) parts.push(h + "h");
    if (m) parts.push(m + "m");
    if (s && !d) parts.push(s + "s");
    return parts.length ? parts.join(" ") : "0s";
  }

  function formatDate(date) {
    try {
      return new Intl.DateTimeFormat(document.documentElement.lang || "en", {
        year: "numeric",
        month: "short",
        day: "numeric",
      }).format(date);
    } catch (e) {
      return date.toDateString();
    }
  }

  function formatDateLong(date) {
    try {
      return new Intl.DateTimeFormat(document.documentElement.lang || "en", {
        weekday: "short",
        year: "numeric",
        month: "short",
        day: "numeric",
      }).format(date);
    } catch (e) {
      return date.toDateString();
    }
  }

  function formatWeekday(date) {
    try {
      return new Intl.DateTimeFormat(document.documentElement.lang || "en", {
        weekday: "short",
      }).format(date);
    } catch (e) {
      return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getDay()];
    }
  }

  // In single-playlist mode, video ranges are shown as "#12–#15".
  // In combined mode, `labels` carries a per-video "Playlist #N" string
  // so a range spanning playlists still reads clearly.
  function formatVideoRange(videos, labels) {
    if (!videos.length) return "";
    if (labels && labels.length) {
      var firstLabel = labels[videos[0]];
      var lastLabel = labels[videos[videos.length - 1]];
      return firstLabel === lastLabel
        ? firstLabel
        : firstLabel + " \u2192 " + lastLabel;
    }
    var first = videos[0] + 1;
    var last = videos[videos.length - 1] + 1;
    if (first === last) return "#" + first;
    return "#" + first + "\u2013#" + last;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[c];
    });
  }

  /**
   * Build a day-by-day plan of remaining videos.
   *
   * Rules:
   *   - Videos are kept intact on a single day whenever possible: a video that
   *     would overflow the day's budget is deferred to the next active day.
   *   - A video longer than one full day's budget is the only exception: it
   *     spans across days with the same index shown on each day it covers.
   *   - `finishDate` is the last day that has any allocated video content.
   *
   * Returns { rows, totalDays, finishDate }. `rows` holds every populated
   * day (uncapped) — the caller decides how much of it to display.
   */
  function buildDailyPlan(
    videoDurations,
    startVideoIdx,
    perDaySeconds,
    speed,
    activeDays,
    startDate,
  ) {
    var rows = [];
    var totalDays = 0;
    var finishDate = new Date(startDate);

    if (!videoDurations || !videoDurations.length) {
      return { rows: rows, totalDays: 0, finishDate: finishDate };
    }

    var contentPerDay = perDaySeconds * (speed || 1);
    if (contentPerDay <= 0)
      return { rows: rows, totalDays: 0, finishDate: finishDate };

    var idx = Math.max(0, Math.min(startVideoIdx, videoDurations.length));
    var spillover = 0;
    var cursor = new Date(startDate);
    var safety = 3650;

    while (idx < videoDurations.length && safety-- > 0) {
      if (activeDays.indexOf(cursor.getDay()) === -1) {
        cursor.setDate(cursor.getDate() + 1);
        continue;
      }

      var budget = contentPerDay;
      var dayVideos = [];
      var dayContent = 0;

      if (spillover > 0 && idx < videoDurations.length) {
        var stillToWatch = videoDurations[idx] - spillover;
        if (stillToWatch <= budget + 0.001) {
          dayContent += stillToWatch;
          budget -= stillToWatch;
          dayVideos.push(idx);
          idx++;
          spillover = 0;
        } else {
          dayContent += budget;
          spillover += budget;
          dayVideos.push(idx);
          budget = 0;
        }
      }

      while (budget > 0.001 && idx < videoDurations.length) {
        var vlen = videoDurations[idx];
        if (vlen <= budget + 0.001) {
          dayContent += vlen;
          budget -= vlen;
          dayVideos.push(idx);
          idx++;
        } else if (vlen > contentPerDay + 0.001) {
          dayContent += budget;
          spillover = budget;
          dayVideos.push(idx);
          budget = 0;
        } else {
          break;
        }
      }

      if (dayVideos.length > 0) {
        totalDays++;
        finishDate = new Date(cursor);
        rows.push({
          date: new Date(cursor),
          videos: dayVideos,
          realSeconds: dayContent / (speed || 1),
        });
      }

      cursor.setDate(cursor.getDate() + 1);
    }

    return { rows: rows, totalDays: totalDays, finishDate: finishDate };
  }

  function renderPlan(plan, labels) {
    if (!elPlanCard || !elPlanBody) return;

    // Remember the full plan so the expand/collapse button can
    // re-render without recomputing the schedule.
    lastPlanRows = plan.rows;
    lastPlanLabels = labels;

    while (elPlanBody.firstChild) elPlanBody.removeChild(elPlanBody.firstChild);

    if (!plan.rows.length) {
      elPlanCard.classList.add("hidden");
      if (elPlanMore) elPlanMore.classList.add("hidden");
      return;
    }

    elPlanCard.classList.remove("hidden");

    var visibleRows = planExpanded
      ? plan.rows
      : plan.rows.slice(0, MAX_PLAN_ROWS);

    visibleRows.forEach(function (row) {
      var tr = document.createElement("tr");
      tr.className = "border-t border-gray-100 dark:border-gray-800";
      tr.innerHTML =
        '<td class="py-1.5 pr-3 text-gray-700 dark:text-gray-300 whitespace-nowrap">' +
        escapeHtml(formatDate(row.date)) +
        "</td>" +
        '<td class="py-1.5 pr-3 text-gray-500 dark:text-gray-400 whitespace-nowrap">' +
        escapeHtml(formatWeekday(row.date)) +
        "</td>" +
        '<td class="py-1.5 pr-3 font-mono text-gray-700 dark:text-gray-300 whitespace-nowrap">' +
        escapeHtml(formatVideoRange(row.videos, labels)) +
        "</td>" +
        '<td class="py-1.5 text-gray-700 dark:text-gray-300 whitespace-nowrap">' +
        escapeHtml(formatDuration(row.realSeconds)) +
        "</td>";
      elPlanBody.appendChild(tr);
    });

    if (elPlanMore) {
      var hiddenCount = plan.rows.length - MAX_PLAN_ROWS;
      if (hiddenCount > 0) {
        elPlanMore.classList.remove("hidden");
        if (planExpanded) {
          elPlanMore.textContent =
            (window.__schedI18n && window.__schedI18n.planShowLess) ||
            "Show less";
        } else {
          var template =
            (window.__schedI18n && window.__schedI18n.planMore) ||
            "\u2026and {n} more day(s)";
          elPlanMore.textContent = template.replace("{n}", hiddenCount);
        }
      } else {
        elPlanMore.classList.add("hidden");
      }
    }
  }

  function onPlanMoreClick() {
    planExpanded = !planExpanded;
    renderPlan({ rows: lastPlanRows }, lastPlanLabels);
  }

  /**
   * Merges every playlist into one virtual playlist: durations are
   * concatenated in playlist order, and `video_labels[i]` records which
   * playlist + local video number that combined index came from, so the
   * plan table stays readable (e.g. "C Programming #12").
   */
  function buildCombinedPlaylist() {
    var totalSeconds = 0;
    var videoCount = 0;
    var durations = [];
    var labels = [];

    playlists.forEach(function (pl) {
      if (!pl) return;
      var name = pl.playlist_name || "Playlist";
      totalSeconds += pl.total_seconds || 0;
      var durs = pl.video_durations || [];
      if (durs.length) {
        videoCount += durs.length;
        durs.forEach(function (d, i) {
          durations.push(d);
          labels.push(name + " #" + (i + 1));
        });
      } else {
        videoCount += pl.video_count || 0;
      }
    });

    var label =
      (window.__schedI18n && window.__schedI18n.combinedLabel) ||
      "All Playlists (Combined)";

    return {
      video_count: videoCount,
      total_seconds: totalSeconds,
      video_durations: durations,
      video_labels: labels,
      playlist_name: label,
    };
  }

  function getCombinedPlaylist() {
    if (!combinedPlaylistCache) combinedPlaylistCache = buildCombinedPlaylist();
    return combinedPlaylistCache;
  }

  function currentPlaylist() {
    if (currentSelection === COMBINED_KEY) return getCombinedPlaylist();
    return playlists[parseInt(currentSelection, 10)] || null;
  }

  /**
   * Builds a <select id="sched-playlist"> automatically if the page markup
   * doesn't already provide one and there's more than one playlist to
   * choose from. Placed right before the progress ring's container.
   */
  function ensurePlaylistSelect() {
    if (elPlaylistSelect || playlists.length < 2) return;

    var container = elRing.closest
      ? elRing.closest("div")
      : elRing.parentElement;
    var host =
      (container && container.parentElement) ||
      elRing.parentElement ||
      document.body;

    elPlaylistSelect = document.createElement("select");
    elPlaylistSelect.id = "sched-playlist";
    elPlaylistSelect.className =
      "mb-3 w-full rounded-md border border-gray-300 dark:border-gray-700 " +
      "bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200 text-sm px-2 py-1.5";

    host.insertBefore(elPlaylistSelect, container || host.firstChild);
  }

  function populatePlaylistSelect() {
    if (!elPlaylistSelect) return;

    while (elPlaylistSelect.firstChild)
      elPlaylistSelect.removeChild(elPlaylistSelect.firstChild);

    playlists.forEach(function (pl, i) {
      var opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent =
        pl && pl.playlist_name ? pl.playlist_name : "Playlist " + (i + 1);
      elPlaylistSelect.appendChild(opt);
    });

    if (playlists.length > 1) {
      var combinedOpt = document.createElement("option");
      combinedOpt.value = COMBINED_KEY;
      combinedOpt.textContent =
        (window.__schedI18n && window.__schedI18n.combinedLabel) ||
        "All Playlists (Combined)";
      elPlaylistSelect.appendChild(combinedOpt);
    }

    elPlaylistSelect.value = currentSelection;
  }

  function calculate() {
    var data = currentPlaylist();

    if (!playlists.length || !data || !data.total_seconds) {
      if (elEmpty) elEmpty.classList.remove("hidden");
      if (elPlanCard) elPlanCard.classList.add("hidden");
      return;
    }
    if (elEmpty) elEmpty.classList.add("hidden");

    var hours = parseFloat(elHours.value) || 0;
    var minutes = parseFloat(elMinutes.value) || 0;
    var speed = parseFloat(elSpeed.value) || 1;
    var startToday = elStartToday ? !!elStartToday.checked : true;
    var perDaySeconds = hours * 3600 + minutes * 60;
    if (perDaySeconds <= 0) perDaySeconds = 3600;

    var activeDays = dayChecks
      .filter(function (c) {
        return c.checked;
      })
      .map(function (c) {
        return parseInt(c.value, 10);
      });
    if (activeDays.length === 0) {
      activeDays = [0, 1, 2, 3, 4, 5, 6];
    }

    var watched = watchedInput
      ? Math.max(0, parseInt(watchedInput.value, 10) || 0)
      : 0;
    var videoDurations = data.video_durations || [];
    var videoLabels = data.video_labels || null;
    var totalVideos = data.video_count || videoDurations.length;
    watched = Math.min(watched, totalVideos);

    watchedBySelection[currentSelection] = watched;

    var watchedSeconds = 0;
    if (videoDurations.length) {
      for (var i = 0; i < watched; i++) {
        watchedSeconds += videoDurations[i] || 0;
      }
    } else if (totalVideos > 0) {
      watchedSeconds = data.total_seconds * (watched / totalVideos);
    }

    var totalSeconds = data.total_seconds;
    var remainingSeconds = Math.max(0, totalSeconds - watchedSeconds);
    var pct = totalSeconds > 0 ? (watchedSeconds / totalSeconds) * 100 : 0;
    var effectiveRemaining = remainingSeconds / (speed || 1);

    var realToday = new Date();
    realToday.setHours(0, 0, 0, 0);
    var startDate = new Date(realToday);
    if (!startToday) startDate.setDate(startDate.getDate() + 1);

    var isDone = remainingSeconds <= 0.5;
    var offset = CIRC * (1 - Math.max(0, Math.min(100, pct)) / 100);
    elRing.setAttribute("stroke-dashoffset", offset.toFixed(2));
    elPct.textContent = pct.toFixed(1) + "%";
    elVideos.textContent = watched + "/" + totalVideos;

    elWatched.textContent = formatDuration(watchedSeconds);
    elRemaining.textContent = formatDuration(effectiveRemaining);
    elTotal.textContent = formatDuration(totalSeconds / (speed || 1));

    if (isDone) {
      elDate.textContent = "\u2713";
      elDays.textContent = "";
      if (elPlanCard) elPlanCard.classList.add("hidden");
      return;
    }

    var plan = videoDurations.length
      ? buildDailyPlan(
          videoDurations,
          watched,
          perDaySeconds,
          speed,
          activeDays,
          startDate,
        )
      : { rows: [], totalDays: 0, finishDate: startDate };

    var finishDate = plan.finishDate;
    var MS_PER_DAY = 86400000;
    var daysUntilFinish = Math.max(
      0,
      Math.round((finishDate - realToday) / MS_PER_DAY),
    );

    elDate.textContent = formatDateLong(finishDate);
    if (daysUntilFinish === 0) {
      elDays.textContent = window.__schedI18n
        ? window.__schedI18n.today
        : "Today";
    } else if (daysUntilFinish === 1) {
      elDays.textContent = window.__schedI18n
        ? window.__schedI18n.oneDay
        : "1 day";
    } else {
      var template = window.__schedI18n ? window.__schedI18n.nDays : "{n} days";
      elDays.textContent = template.replace("{n}", daysUntilFinish);
    }

    renderPlan(plan, videoLabels);
  }

  function onPlaylistChange() {
    currentSelection = elPlaylistSelect.value;
    planExpanded = false;
    if (watchedInput) {
      watchedInput.value = watchedBySelection.hasOwnProperty(currentSelection)
        ? watchedBySelection[currentSelection]
        : 0;
    }
    calculate();
  }

  function bind() {
    var inputs = [elHours, elMinutes, elSpeed, elStartToday];
    if (watchedInput) inputs.push(watchedInput);
    inputs.forEach(function (el) {
      if (!el) return;
      el.addEventListener("input", calculate);
      el.addEventListener("change", calculate);
    });
    dayChecks.forEach(function (c) {
      c.addEventListener("change", calculate);
    });

    if (elPlaylistSelect) {
      elPlaylistSelect.addEventListener("change", onPlaylistChange);
    }

    if (elPlanMore) {
      elPlanMore.addEventListener("click", onPlanMoreClick);
    }
  }

  function init() {
    ensurePlaylistSelect();
    populatePlaylistSelect();
    bind();
    calculate();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
