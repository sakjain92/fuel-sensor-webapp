// Pure logic of the phone app: UI strings, formatters, status mapping, validation, fill-report helpers, package header.
// No DOM, no Bluetooth: the node tests import this file directly. Ported from the 1.2.5 dashboard (web/index.html CORE).
// Customer-facing text never mentions cycles, bugs or tracker internals. Every UI string lives in STRINGS (Hindi later).

export const STRINGS = {
  en: {
    lang: 'en',
    pageTitle: 'MRM Fuel Sensor',
    appTitle: 'Fuel sensor',
    unitL: 'L',
    unitMm: 'mm',
    ofCap: 'of {c} L',
    rawLitres: 'Raw Litres: {v}/{m}',
    rawTable: 'Litres → Raw Litres table',
    rawTableHint: 'A linear 0-{m} scale: 0 is empty, {m} is this tank’s capacity ({c} L). Recalculates if the tank size changes.',
    rawTableL: 'Litres',
    rawTableR: 'Raw Litres',
    updatedNow: 'Updated just now',
    updatedAgo: 'Updated {t} ago',
    lastUpd: 'Last update {t} ago',
    st_steady: 'Level steady',
    st_moving: 'Fuel level changing',
    st_checking: 'Checking the level. It may still change.',
    st_holding: 'Fuel moving or splashing. Showing the last steady level.',
    st_starting: 'Just started. Showing the last saved level.',
    st_no_radar: 'Radar not responding. Showing the last level.',
    st_safe_mode: 'Sensor fault. Showing the last saved level.',
    st_unknown: 'Status: {s}',
    noteSaved: 'Showing the last saved level',
    noteNone: 'No level measured yet',
    details: 'Device details',
    d_mac: 'Sensor ID (MAC)',
    d_fw: 'Firmware version',
    d_build: 'Build',
    d_site: 'Site ID',
    d_siteLoc: 'Site location',
    d_temp: 'Radar temperature',
    d_uptime: 'Running for',
    d_pwr: 'Power interruptions',
    d_tank: 'Tank L × W × H',
    d_lpmm: 'Litres per mm',
    d_health: 'Health',
    na: 'not reported',
    notSet: 'not set',
    degC: '{v} °C',
    tankDims: '{l} × {w} × {h} mm',
    tankDefault: 'default',
    tankCustom: 'custom',
    var_debug: 'Debug',
    var_production: 'Production',
    hf_ok: 'All normal',
    hf_safe: 'Safe mode',
    hf_trial: 'New firmware on trial',
    hf_crash: 'Crash report stored',
    hf_radar: 'Radar link down',
    hf_reset: 'Last start after {r}',
    rr_unknown: 'unknown',
    rr_poweron: 'power on',
    rr_ext: 'reset pin',
    rr_sw: 'software restart',
    rr_panic: 'crash',
    rr_int_wdt: 'watchdog',
    rr_task_wdt: 'watchdog',
    rr_wdt: 'watchdog',
    rr_deepsleep: 'wake from sleep',
    rr_brownout: 'power dip',
    rr_sdio: 'SDIO reset',
    dur_s: '{s} s',
    dur_m: '{m} min',
    dur_hm: '{h} h {m} min',
    dur_dh: '{d} d {h} h',
    wait_ms: '{m} min {s} s',
    months: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],

    // Connect screen and Bluetooth
    demoTag: 'Demo',
    cn_title: 'Connect to the sensor',
    cn_sensor: 'Sensor',
    cn_help: 'Stand close to the sensor and make sure Bluetooth is switched on. Press Connect, then choose this sensor in the list.',
    cn_helpAny: 'Stand close to the sensor and make sure Bluetooth is switched on. Press Connect, then choose your sensor in the list. Its name starts with PROCOM-SENSOR-.',
    cn_btn: 'Connect',
    cn_again: 'Connect again',
    cn_choosing: 'Choose the sensor in the list…',
    cn_connecting: 'Connecting to the sensor…',
    cn_starting: 'Starting…',
    cn_demo: 'Demo mode: a simulated sensor. No Bluetooth is used.',
    cn_busy: 'The sensor can talk to one phone at a time. If it does not show up, disconnect the other phone first.',
    cn_perm: 'If Chrome asks to turn on Location, or to allow Nearby devices, say yes: Android needs it to find the sensor.',
    ce_cancelled: 'No sensor was chosen. Press Connect and pick the sensor in the list.',
    ce_off: 'Bluetooth is switched off. Turn it on in the phone settings and try again.',
    ce_notfound: 'The sensor was not found. Move closer. If another phone is connected to it, disconnect that phone first.',
    ce_failed: 'Could not connect. Move closer to the sensor and try again.',
    ce_blocked: 'Bluetooth is not allowed on this page. Check the site permissions in Chrome.',
    ce_notsensor: 'This device does not look like an MRM fuel sensor.',
    ce_proto: 'This sensor speaks a newer version of the protocol. Reload this page to get the latest version of the app.',
    unsupported: 'For the best experience, open this page in Google Chrome on an Android phone.',
    unsupportedId: 'Sensor {id}',
    bt_lost: 'Bluetooth connection lost.',
    bt_lostHint: 'Move closer to the sensor, then reconnect. Maintenance approval ends when the connection drops.',
    bt_reconnect: 'Reconnect',
    bt_reconnecting: 'Reconnecting…',
    bt_reconnectFail: 'Could not reconnect yet. Move closer and try again.',
    bt_disconnect: 'Disconnect from the sensor',
    bt_disconnectNote: 'The sensor talks to one phone at a time. Disconnect when you are done.',
    bt_label: 'Bluetooth',
    bt_off: 'disconnected',
    bt_connected: 'connected',
    bt_signal: 'signal {s} ({d} dBm)',
    bt_signalNone: 'signal not measured',
    bt_sig_strong: 'strong',
    bt_sig_good: 'good',
    bt_sig_weak: 'weak',
    bt_sig_veryweak: 'very weak',
    bt_phy_2M: 'fast (2M)',
    bt_phy_1M: 'standard (1M)',
    bt_phy_coded: 'long range',
    bt_phy_unknown: 'radio {p}',

    // Protocol error codes (PROTOCOL.md 3.4)
    errNet: 'No answer from the sensor. Check the Bluetooth connection and try again.',
    errGone: 'The Bluetooth connection to the sensor was lost.',
    e_bad_request: 'The sensor did not understand the request. Reload the page and try again.',
    e_unknown_cmd: 'This sensor does not support that function.',
    e_line_too_long: 'The request was too long for the sensor.',
    e_too_big: 'The sensor’s answer was too long to send.',
    e_bad_input: 'The sensor did not accept that value. Check it and try again.',
    e_no_session: 'Maintenance approval has ended. Get approval again to continue.',
    e_grant: 'Your approval does not allow this.',
    e_format: 'This is not a complete reply code.',
    e_wrong: 'Wrong code.',
    e_locked: 'Too many wrong codes. The sensor is locked for a while.',
    e_no_challenge: 'This code is no longer valid. Get a new code and send it to IT.',
    e_store: 'The sensor could not save this. Try again.',
    e_confirm: 'The reset was not confirmed.',
    e_busy: 'The sensor is busy (an update is running, or it is still starting). Try again in a moment.',
    e_no_dump: 'There is no crash report on the sensor.',
    e_link_mode: 'Switch the radio to fast mode first.',
    e_other: 'The sensor reported a problem: {m}',

    // Maintenance and login
    maint: 'Maintenance',
    maintOpen: 'Maintenance (unlocked)',
    back: 'Back',
    maintTitle: 'Maintenance',
    loginIntro: 'Changing settings or firmware needs approval from your IT team. Send them this code.',
    step1: 'Send this code to IT',
    step2: 'Paste the reply from IT',
    codeWait: 'Getting the code…',
    codeFail: 'No answer from the sensor.',
    retry: 'Try again',
    sensorId: 'Sensor {m}',
    copy: 'Copy code',
    copied: 'Copied',
    copyHold: 'Press and hold the code, then choose Copy.',
    share: 'Share',
    shWa: 'WhatsApp',
    shSms: 'SMS',
    shMail: 'Email',
    shareText: 'MRM fuel sensor {m}, maintenance code:\n{c}',
    shareSubj: 'Fuel sensor maintenance code',
    respPh: 'Paste the reply code here',
    respCount: '{n} of 104 characters',
    respFull: 'Complete reply code',
    respEmpty: 'Paste the reply from IT first.',
    respShort: 'This reply looks incomplete: {n} of 104 characters. Copy the whole reply from IT. To send it anyway, press Unlock again.',
    respBad: 'This reply has characters that are not in a code. Check it. To send it anyway, press Unlock again.',
    unlock: 'Unlock',
    checking: 'Checking…',
    lg_wrong: 'Wrong code. Check that IT signed this exact code, and paste their whole reply. After 5 wrong tries the sensor makes you wait 15 minutes.',
    lg_locked: 'Too many wrong codes. The sensor is locked for a while.',
    lg_service: 'This is an approval for service work. It does not open maintenance here.',
    lg_noChal: 'This code is no longer valid. Get a new code and send it to IT.',
    lg_format: 'This is not a complete reply code. Copy the whole reply from IT and paste it again.',
    lockWait: 'Locked. You can try again in {t}.',
    newCode: 'Get a new code',
    newCodeQ: 'A new code replaces this one. A reply that IT made for the old code will no longer work.',
    newCodeYes: 'Get new code',
    newSame: 'This code is still current, so a reply IT made for it still works. A new code can be made in {t}.',
    demoReply: 'Demo mode: the reply code is {c}',
    cancel: 'Cancel',
    sessEnded: 'Session ended. Get approval again to continue.',
    unlocked: 'Maintenance unlocked',
    sessLeft: 'Time left: {t}',
    sessNote: 'Access ends after 15 minutes without use, and when the Bluetooth connection drops.',
    grantIs: 'This approval allows: {g}.',
    g_settings: 'tank size, site details, fuel totals',
    g_firmware: 'firmware update',
    g_older: 'older firmware',
    g_none: 'viewing only',
    finish: 'Finish',
    tankTitle: 'Tank size',
    tankNow: 'Now: {d}',
    dimL: 'Length (mm)',
    dimW: 'Width (mm)',
    dimH: 'Height (mm)',
    dim_l: 'Length',
    dim_w: 'Width',
    dim_h: 'Height',
    dimErr: '{f}: {m}',
    dimE_empty: 'enter a size in mm',
    dimE_num: 'enter a number',
    dimE_range: 'enter 10 to 10000 mm',
    tankPrev: '{p} L per mm',
    tankPrevCap: '{p} L per mm · full tank {c} L',
    save: 'Save',
    saving: 'Saving…',
    tankSaved: 'Saved. The litres shown now use this tank size.',
    tankFail: 'Not saved: {e}',
    useDefault: 'Use default (calibrated Eicher tank)',
    defaultQ: 'Go back to the calibrated Eicher tank size?',
    defaultYes: 'Use default',

    siteTitle: 'Site',
    siteNow: 'Site ID now: {v}',
    siteLabel: 'Site ID (up to 16 characters)',
    siteSave: 'Save site ID',
    siteClear: 'Clear site ID',
    siteEmpty: 'Type a site ID, or press Clear site ID to remove it.',
    siteSaved: 'Site ID saved.',
    siteCleared: 'Site ID cleared.',
    siteFail: 'Not saved: {e}',
    siteE_long: 'Use at most 16 characters.',
    siteE_char: 'Use letters, numbers, spaces and - _ . / only.',
    siteE_first: 'The first character must be a letter or a number.',
    siteHint: 'Letters, numbers, spaces and - _ . / only. The first character is a letter or a number. Spaces at the end are removed.',
    locTitle: 'Site location',
    locNow: 'Location now: {v}',
    locHint: 'Stand at the sensor. The location goes into every fill report and is shown to IT.',
    locUse: 'Use my location',
    locGetting: 'Getting your location…',
    locFix: 'Position {lat}, {lon} (±{a} m)',
    locWeak: 'The position is only accurate to ±{a} m. Move to open sky and try again, or save it anyway.',
    locSave: 'Save this location',
    locSaved: 'Site location saved.',
    locFail: 'Not saved: {e}',
    loc_denied: 'Location is switched off or not allowed for this page.',
    loc_unavailable: 'No position was found. Move to open sky and try again.',
    loc_timeout: 'Finding your position took too long. Try again.',
    loc_unsupported: 'This phone cannot give a location to this page.',
    loc_weak: 'Precise location is off or only approximate. Turn on precise location and try again.',

    // Maintenance: the sensor's own clock, compared with this phone
    clkTitle: 'Sensor clock',
    clkReading: 'Reading the sensor clock…',
    clkSet: 'Set',
    clkNotSet: 'Not set',
    clkSrc: 'Source: {s}.',
    clkSrc_rtc: 'the sensor’s own clock chip',
    clkSrc_phone: 'set from a phone (lost when the sensor restarts)',
    clkSrc_other: 'another source',
    clkSrc_none: 'none',
    clkSrc_none_rtc: 'none (a clock chip is fitted but holds no time)',
    clkSame: 'The same time as this phone.',
    clkAhead: 'About {d} ahead of this phone.',
    clkBehind: 'About {d} behind this phone.',
    clkNoneNote: 'Fill reports made now carry no sensor time.',
    clkHint: 'Every fill report carries the sensor’s own time next to this phone’s time, so IT can see that the two agree. The sensor’s time can only be changed here, with maintenance approval.',
    clkBtn: 'Set from this phone',
    clkQ: 'Set the sensor clock to this phone’s time? This counts as a settings change.',
    clkYes: 'Set the clock',
    clkDone: 'The sensor clock was set from this phone.',
    clkBad: 'The sensor did not accept this phone’s time. Check the date and time on this phone.',
    clkFail: 'The clock was not set: {e}',
    clkReadFail: 'Could not read the sensor clock: {e}',

    fwTitle: 'Firmware update',
    fwNow: 'Installed: {v} ({b})',
    fwChoose: 'Choose update file (.fwpkg)',
    fwOpen: 'Update firmware',
    fw_file: 'File',
    fw_ver: 'Version',
    fw_verVs: '{v} (installed {i})',
    fw_chip: 'Chip',
    fw_var: 'Variant',
    fw_built: 'Built',
    fw_e_notpkg: 'This is not a firmware file for this sensor.',
    fw_e_size: 'The file is incomplete or damaged. Get it again.',
    fw_e_chip: 'This file is for {p}. This sensor is {d}.',
    fw_e_big: 'This file is too large for this sensor.',
    fw_e_variant: 'This file is not a known firmware variant.',
    fw_e_older: 'This is older than the installed version {v}. Your approval does not allow going back.',
    fw_w_same: 'This is the version already installed.',
    fw_w_variant: 'This is a {p} build. The sensor now runs a {d} build.',
    fw_w_demo: 'Demo mode: this is not a real firmware package. The simulated sensor accepts any file.',
    fw_w_older: 'This is older than the installed version {v}. Your approval allows going back.',
    fwInstall: 'Install {v}',
    fwSummary: '{chip} - {variant} - version {v}',
    fwInstallAny: 'Install this file',
    fwFailed: 'The update did not finish',
    fwKeep: 'Keep this screen on and stay close to the sensor until the update has finished.',
    fwRadio: 'Switching the radio to fast mode…',
    fwBegin: 'Starting the update…',
    fwSending: 'Sending… {p} %',
    fwBytes: '{a} of {b}',
    fwSpeedLbl: 'Speed {v}',
    fwEta: 'about {t} left',
    fwEtaCalc: 'working out the time left…',
    fwEtaDone: 'almost done',
    fwChecking: 'Checking the file on the sensor…',
    fwCancel: 'Cancel update',
    fwCancelled: 'Update cancelled. The sensor kept its current firmware.',
    fwAccepted: 'The sensor accepted the update and is restarting.',
    fwDrop: 'The Bluetooth connection dropped before the update finished. The sensor keeps its current firmware. Move closer, reconnect and try again.',
    fwStalled: 'The sensor stopped answering during the update. The sensor keeps its current firmware. Move closer and try again.',
    fwRefused: 'The sensor refused the file: {e}.',
    fwBusy: 'The sensor is busy. Try again in a moment.',
    fwLost: 'The sensor stopped the update. The sensor keeps its current firmware. Start the update again.',
    ota_format: 'not a firmware file',
    ota_chip: 'wrong chip',
    ota_variant: 'wrong variant',
    ota_older: 'older version',
    ota_big: 'too large',
    ota_signature: 'signature not valid',
    ota_image: 'damaged image',
    ota_hash: 'file damaged in transfer',
    ota_write: 'flash write failed',
    ota_busy: 'sensor busy',
    ota_grant: 'your approval does not allow a firmware update',
    ota_no_session: 'approval has ended',
    ota_link_mode: 'the radio is in long-range mode',
    crashTitle: 'Crash report',
    crashText: 'A crash report is stored on the sensor. Download it and send it to MRM support.',
    crashDl: 'Download crash report',
    crashReading: 'Reading the crash report… {p} %',
    crashGot: 'Downloaded.',
    crashErase: 'Erase crash report',
    crashEraseQ: 'Erase the crash report from the sensor?',
    crashEraseYes: 'Erase',
    crashNone: 'There is no crash report on the sensor.',

    // Fill reports
    frTitle: 'Fill report',
    frIdleHint: 'Before you pour, press Start filling. When you have finished, press End filling and enter the litres you filled.',
    frStart: 'Start filling',
    frFilling: 'Filling since {t}',
    frFillHint: 'Press End filling when you have stopped pouring.',
    frEnd: 'End filling',
    frMeas: 'Preparing… {t}/{m}',
    frLitres: 'Litres you filled',
    frBlind: 'Enter the litres from the pump meter or the cans, not from this screen.',
    frConfirm: 'Confirm and sign',
    frBadL: 'Enter the litres you filled, for example 50 or 50.5.',
    frRestarted: 'The sensor restarted during this fill. The report says so.',
    frDoneMsg: 'Fill report #{n} is signed. Copy it or send it on WhatsApp.',
    frLast: 'Last fill report',
    frFigs: 'Operator {o}',
    frNotEntered: 'not entered',
    frFlags: 'Check: {f}',
    frCopy: 'Copy',
    frWa: 'Send on WhatsApp',
    frFile: 'Share report file',
    frFileHint: 'The file is encrypted for your IT team. Only they can open it: send it on as it is.',
    frFileTest: 'Test encryption key: IT cannot open this file yet.',
    frFileMaking: 'Preparing the file…',
    frFileShared: 'File shared.',
    frFileSaved: 'File saved to the Downloads folder.',
    frFileFail: 'Could not prepare the file.',
    frTimeNA: 'time unknown',
    frLocating: 'Getting your location…',
    frLocHint: 'The report records where you pressed Start.',
    frSkipLoc: 'Continue without location',
    frTryAgain: 'Try again',
    frNoLoc: '{why} You can continue without it. The report then will not include your position.',
    frLocOk: 'Position saved (±{a} m).',
    frLocNone: 'No position saved.',
    frMoved: 'You are {m} m from where you pressed Start. The report will say that you moved more than 100 m.',
    frf_0: 'sensor restarted',
    frf_1: 'level had not settled',
    frf_3: 'tank size changed',
    frf_4: 'level not confirmed',
    frf_5: 'a fuel event is unverified',
    frf_6: 'closed automatically',
    frf_7: 'moved more than 100 m from the start position',
    frf_8: 'fuel was already flowing when Start was pressed, so the sensor litres may include some of it',
    fre_busy: 'A fill report is already open.',
    fre_rate_limited: 'Too many fill reports. Wait 10 minutes.',
    fre_measuring: 'Still measuring. Wait until the level has settled.',
    fre_not_open: 'There is no open fill report. Press Start filling first.',
    fre_not_ready: 'The level has not settled yet. Wait a little.',
    fre_off: 'Fill reports are not available on this sensor.',
    fre_sign_error: 'The sensor could not sign the report. Try again.',
    fre_store_error: 'The sensor could not save the report. Try again.',
    fre_bad_input: 'The sensor did not accept the litres. Check the number.',
    fillsTitle: 'Fill reports',
    fillsHint: 'Newest first. The code is the signed report: IT checks it with the MRM authority tool.',
    fillsNone: 'No fill reports yet.',
    fillsLoading: 'Loading fill reports…',
    fillsSum: 'Operator {o} · sensor {s} · drained {d}',
    fillsCopy: 'Copy report',
    fillsShareAll: 'Share all reports as a file ({n})',
    fillsMore: 'Showing the newest {n} of {c}.',
    totFilled: 'Filled since installation',
    totDrained: 'Drained since installation',
    totFills: '{n} fills',
    totFill1: '1 fill',
    totDrains: '{n} removals',
    totDrain1: '1 removal',
    totFilling: 'Filling now: +{v} L so far',
    totDraining: 'Fuel going out now: {v} L so far',
    totSlow: 'Slow fuel use being counted (engine running, or a leak)',

    rstTitle: 'Reset to defaults',
    rstText: 'For a new installation: sets the tank size, the fuel totals, the remembered level and the site ID and location back to the start.',
    rstKeep: 'Kept: the firmware, the sensor’s keys and identity, its event log and the fill-report numbering.',
    rstBtn: 'Reset to defaults',
    rstQ: 'This clears, and cannot be undone:',
    rstL1: 'the tank size (back to the calibrated Eicher tank)',
    rstL2: 'the fuel totals: filled and drained go back to 0 (the old totals stay in the event log)',
    rstL3: 'the remembered fuel level',
    rstL4: 'the list of fill reports on the sensor and their count since the reset (report numbers keep counting up)',
    rstL5: 'the site ID and the site location',
    rstType: 'Type RESET to confirm',
    rstTypeLbl: 'Confirmation',
    rstAfter: 'The sensor restarts about 2 s after “Reset now”. The next start-up measures the level from scratch and takes up to about 2 min to settle.',
    rstYes: 'Reset now',
    rstFail: 'Not reset: {e}',
    w_resetting: 'Resetting to defaults…',
    w_resetDone: 'Reset to defaults done',
    w_resetSub: 'The tank size, the fuel totals, the site ID and the site location are back at the start. The level settles within about 2 min.',
    rsTitle: 'Restart sensor',
    rsText: 'The level is saved first. The sensor is back in about 30 s.',
    rsBtn: 'Restart sensor',
    rsQ: 'Restart the sensor now? Maintenance ends.',
    rsYes: 'Restart now',
    w_restarting: 'Restarting…',
    w_reconnect: 'The app reconnects by itself in about 30 s.',
    w_hint: 'Stay close to the sensor with Bluetooth switched on. This page updates by itself.',
    w_long: 'Still waiting for the sensor. Stay close to it and check that Bluetooth is on.',
    w_restarted: 'The sensor restarted.',
    w_trial: 'Now running {v}. Checking itself…',
    w_trialSub: 'This takes up to 2 minutes. Stay close to the sensor.',
    w_updated: 'Update complete. Now running {v}.',
    w_rolledBack: 'The update did not work. The sensor went back to {v}.',
    w_rolledSub: 'The sensor keeps working on the old version. Tell MRM support.',
    w_trialSlow: 'Now running {v}. Its self-check has not finished yet.',
    w_ended: 'Maintenance has ended. Get approval again for more changes.',
    w_giveup: 'The sensor did not come back yet. Press Connect to reconnect.',
    backHome: 'Back to fuel level',

    // RS-485 registers and the radio mode
    rgTitle: 'RS-485 registers',
    rgBtn: 'RS-485 registers',
    rgIntro: 'The values the sensor sends to the RS-485 (Modbus) receiver, as that receiver sees them.',
    rgReg: 'Register',
    rgName: 'Item',
    rgRaw: 'Raw (hex)',
    rgValue: 'Value',
    rgReceiver: 'receiver only',
    rgReceiverHint: 'Filled in by the receiver, not by the sensor.',
    rgLive: 'Live · block {s}',
    rgStale: 'No new data for {t}',
    rgWaiting: 'Waiting for data…',
    rgInvalid: 'invalid',
    rgNotSet: 'not set',
    rgNever: 'never',
    rgNone: 'none',
    rgUnknownItem: 'Register {r}',
    rgUnknownValue: 'unknown',
    lrTitle: 'Long-range mode',
    lrToggleOn: 'Long-range mode is on',
    lrToggleOff: 'Long-range mode is off',
    lrTurnOn: 'Turn on long-range mode',
    lrTurnOff: 'Turn off long-range mode',
    lrHelp: 'Long-range mode lets this phone read the registers from much farther away, but slowly. Connect close to the sensor first, turn it on, then walk away. If the connection drops, come back close and connect again.',
    lrSwitching: 'Switching…',
    lrPhy: 'Radio: {p}',
    lrRssi: 'Signal: {s} dBm',
    lrRssiNone: 'Signal: not measured',
    lrNoSupport: 'This phone did not switch to long range, so the radio stays on {p}. Not every phone supports it.',
    lrOkCoded: 'Long range is active.',
    lrFail: 'Could not change the radio mode: {e}',
    lrSlow: 'In long-range mode only status and registers are available. Firmware updates need fast mode.',

    // Debug logs
    lgTitle: 'Device log',
    lgBtn: 'Device log',
    lgIntro: 'Debug build only. Newest lines at the bottom.',
    lgDebugLines: 'Include debug lines',
    lgPause: 'Pause',
    lgResume: 'Resume',
    lgClear: 'Clear',
    lgCopy: 'Copy log',
    lgEmpty: 'No log lines yet.',
    lgLost: '{n} older lines were lost.',
    lgLoading: 'Loading…',
    lgPaused: 'Paused',
    lgCopyMsg: 'Log copied.',

    // Wait pages
    wait_title: 'Working…',
    backToConnect: 'Back to Connect'
  }
};
export let STR = STRINGS.en;

export const DEFAULT_LPMM = 1.3863856924996534;
export const DIM_MIN = 10;
export const DIM_MAX = 10000;
export const SITE_ID_MAX = 16;
export const LOC_WARN_M = 50;
export const MOVED_WARN_M = 100;
export const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const SENSOR_NAME_PREFIX = 'PROCOM-SENSOR-';

export function t(key, vars) {
  let s = STR[key];
  if (s === undefined) s = key;
  if (vars) {
    s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined ? m : String(vars[k])));
  }
  return s;
}
export function fin(x) { return typeof x === 'number' && isFinite(x); }
export function pad2(n) { return (n < 10 ? '0' : '') + n; }

// ---------------------------------------------------------------- formatters
export function fmtNum(x, d) {
  if (!fin(x)) x = 0;
  const s = Math.abs(x).toFixed(d);
  const p = s.split('.');
  p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (x < 0 && Number(s) !== 0 ? '-' : '') + p.join('.');
}
export function fmtLitres(x) { return fmtNum(x, fin(x) && Math.abs(x) >= 1000 ? 0 : 1); }
export function fmtMm(x) { return fmtNum(x, 1); }
export function fmtPct(x) { return fmtNum(x, fin(x) && Math.abs(x) < 10 ? 1 : 0); }
export function fmtLpmm(x) { return fmtNum(x, 3); }
export function fmtDuration(s) {
  s = fin(s) && s > 0 ? Math.floor(s) : 0;
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  if (s < 60) return t('dur_s', { s });
  if (s < 3600) return t('dur_m', { m });
  if (s < 86400) return t('dur_hm', { h, m });
  return t('dur_dh', { d, h });
}
export function fmtWait(s) {
  s = fin(s) && s > 0 ? Math.ceil(s) : 0;
  return s < 60 ? t('dur_s', { s }) : t('wait_ms', { m: Math.floor(s / 60), s: s % 60 });
}
export function fmtAgo(s) { return fin(s) && s >= 3 ? t('updatedAgo', { t: fmtDuration(s) }) : STR.updatedNow; }
export function fmtBytes(n) {
  if (!fin(n) || n < 0) return STR.na;
  if (n < 1024) return n + ' B';
  if (n < 1048576) return Math.round(n / 1024) + ' KB';
  return (n / 1048576).toFixed(2) + ' MB';
}
// Unix seconds -> "12 Oct 2026, 14:03 IST" (times are shown in IST).
export function fmtIST(u) {
  if (!fin(u) || u <= 0) return '';
  const d = new Date((u + 19800) * 1000);
  return d.getUTCDate() + ' ' + STR.months[d.getUTCMonth()] + ' ' + d.getUTCFullYear() + ', ' +
    pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ' IST';
}
// Phone-local clock time; adds the date when it is not today.
export function fmtClock(ms, nowMs) {
  const d = new Date(ms), n = new Date(nowMs), hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  return d.toDateString() === n.toDateString() ? hm : d.getDate() + ' ' + STR.months[d.getMonth()] + ' ' + hm;
}
// Transfer speed, bytes per second.
export function fmtSpeed(bps) {
  if (!fin(bps) || bps <= 0) return '–';
  if (bps < 1024) return Math.round(bps) + ' B/s';
  const k = bps / 1024;
  return (k < 100 ? k.toFixed(1) : String(Math.round(k))) + ' KB/s';
}
// Time left as words: "38 s", "1 min 40 s", "1 h 5 min". The caller wraps it in fwEta ("about ... left").
export function fmtEtaSpan(s) {
  s = fin(s) && s > 0 ? Math.ceil(s) : 0;
  if (s < 60) return s + ' s';
  if (s < 3600) return Math.floor(s / 60) + ' min' + (s % 60 ? ' ' + (s % 60) + ' s' : '');
  return Math.floor(s / 3600) + ' h ' + Math.floor(s % 3600 / 60) + ' min';
}
export function fmtEta(s) {
  if (!fin(s)) return STR.fwEtaCalc;
  if (s < 3) return STR.fwEtaDone;
  return t('fwEta', { t: fmtEtaSpan(s) });
}

// ---------------------------------------------------------------- status JSON (PROTOCOL.md section 2)
// The level always has a value: missing numbers fall back, never to dashes.
export function levelOf(st) { return st && fin(st.level_mm) ? st.level_mm : 0; }
export function lpmmOf(st) { return st && st.tank && fin(st.tank.lpmm) && st.tank.lpmm > 0 ? st.tank.lpmm : DEFAULT_LPMM; }
export function litresOf(st) { return st && fin(st.litres) ? st.litres : levelOf(st) * lpmmOf(st); }
export function capacityOf(st) {
  if (st && fin(st.capacity_l)) return st.capacity_l;
  return st && st.tank && fin(st.tank.h_mm) ? st.tank.h_mm * lpmmOf(st) : 0;
}
export function fillPctOf(st) {
  if (st && fin(st.fill_pct)) return st.fill_pct;
  const c = capacityOf(st);
  return c > 0 ? 100 * litresOf(st) / c : 0;
}
// A customer's downstream register: 0-4095, linear on litres, clamped (same as the 1.2.5 dashboard).
export const RAW_LITRES_MAX = 4095;
export function rawLitresFromLitres(litres, capacity) {
  if (!(capacity > 0)) return 0;
  return Math.max(0, Math.min(RAW_LITRES_MAX, Math.round(litres * RAW_LITRES_MAX / capacity)));
}
export function rawLitresOf(st) {
  if (st && fin(st.raw_litres)) return st.raw_litres;
  return rawLitresFromLitres(litresOf(st), capacityOf(st));
}

const STATUS_CLS = { steady: 'ok', moving: 'neu', checking: 'neu', starting: 'neu', holding: 'warn', no_radar: 'warn', safe_mode: 'bad' };
// Status lines that already say which level is shown (no extra "last saved level" note).
const STATUS_SAYS_LAST = { holding: 1, starting: 1, no_radar: 1, safe_mode: 1 };
export function statusView(status, source) {
  const cls = STATUS_CLS[status];
  const text = cls ? STR['st_' + status] : t('st_unknown', { s: status || '?' });
  let note = '';
  if ((source === 'stored' || source === 'last_confirmed') && !STATUS_SAYS_LAST[status]) note = STR.noteSaved;
  else if (source === 'none') note = STR.noteNone;
  return { cls: cls || 'neu', text, note };
}

const RESET_BAD = { panic: 1, int_wdt: 1, task_wdt: 1, wdt: 1, brownout: 1 };
export function resetReasonText(r) { const n = String(r || 'unknown'); return STR['rr_' + n] || n; }
export function healthFlags(h, radar) {
  const f = [];
  h = h || {};
  if (h.safe_mode) f.push(STR.hf_safe);
  if (h.trial) f.push(STR.hf_trial);
  if (h.coredump) f.push(STR.hf_crash);
  if (radar && radar.link && radar.link !== 'ok') f.push(STR.hf_radar);
  if (RESET_BAD[String(h.reset_reason || '')]) f.push(t('hf_reset', { r: resetReasonText(h.reset_reason) }));
  return f;
}
export function chipName(c) {
  const ids = { esp32: 0, esp32c3: 5 }, names = { 0: 'ESP32', 5: 'ESP32-C3' };
  if (typeof c === 'string') return ids[c] !== undefined ? names[ids[c]] : c.toUpperCase();
  return names[c] || (fin(c) ? 'chip ' + c : STR.na);
}
export function buildText(variant) { return STR['var_' + variant] || variant || STR.na; }
export function numStr(x) { return fin(x) ? String(Math.round(x * 10) / 10) : ''; }
export function tankText(tk) {
  tk = tk || {};
  return t('tankDims', { l: numStr(tk.l_mm), w: numStr(tk.w_mm), h: numStr(tk.h_mm) }) + ', ' + (tk.custom ? STR.tankCustom : STR.tankDefault);
}
export function grantText(g) {
  g = g || {};
  const a = [];
  if (g.settings) a.push(STR.g_settings);
  if (g.firmware) a.push(STR.g_firmware);
  if (g.firmware && g.older) a.push(STR.g_older);
  return t('grantIs', { g: a.length ? a.join(', ') : STR.g_none });
}
// "12.971599, 77.594566" or "not set".
export function siteLocText(st) {
  if (st && fin(st.site_lat) && fin(st.site_lon)) return st.site_lat.toFixed(6) + ', ' + st.site_lon.toFixed(6);
  return STR.notSet;
}
// Fuel totals for the home page (status.fuel): null when the device sends none.
export function fuelView(st) {
  const f = st && st.fuel;
  if (!f || !fin(f.filled_l) || !fin(f.drained_l)) return null;
  const n = (k1, kn, c) => (fin(c) ? (c === 1 ? STR[k1] : t(kn, { n: fmtNum(c, 0) })) : '');
  let now = '';
  if (f.active === 'fill' && fin(f.pending_l)) now = t('totFilling', { v: fmtLitres(f.pending_l) });
  else if (f.active === 'drain' && fin(f.pending_l)) now = t('totDraining', { v: fmtLitres(Math.abs(f.pending_l)) });
  else if (f.active === 'slow_drain') now = STR.totSlow;
  return { filled: fmtLitres(f.filled_l), drained: fmtLitres(f.drained_l), fills: n('totFill1', 'totFills', f.fills),
    drains: n('totDrain1', 'totDrains', f.drains), now };
}

// ---------------------------------------------------------------- Bluetooth line
export function signalWord(rssi) {
  if (!fin(rssi)) return '';
  if (rssi >= -60) return STR.bt_sig_strong;
  if (rssi >= -75) return STR.bt_sig_good;
  if (rssi >= -85) return STR.bt_sig_weak;
  return STR.bt_sig_veryweak;
}
export function phyText(phy) {
  if (phy === '2M' || phy === '1M' || phy === 'coded') return STR['bt_phy_' + phy];
  return phy ? t('bt_phy_unknown', { p: phy }) : '';
}
// "connected · signal good (-62 dBm) · fast (2M)" from the latest `link` reply/event.
export function linkSummary(link) {
  const parts = [STR.bt_connected];
  if (link && fin(link.rssi)) parts.push(t('bt_signal', { s: signalWord(link.rssi), d: Math.round(link.rssi) }));
  else parts.push(STR.bt_signalNone);
  if (link && link.phy) parts.push(phyText(link.phy));
  return parts.join(' · ');
}

// ---------------------------------------------------------------- browser and URL
// Web Bluetooth exists in Chrome on Android (and desktop Chrome/Edge) on HTTPS or localhost only.
export function browserSupport(env) {
  const nav = env && env.navigator;
  if (nav && nav.bluetooth && typeof nav.bluetooth.requestDevice === 'function') return { ok: true };
  return { ok: false, reason: env && env.isSecureContext === false ? 'insecure' : 'no_bluetooth' };
}
// ?d=PROCOM-SENSOR-<12 uppercase hex> -> {name, mac}; the bare 12 digits are accepted too; anything else -> null.
export function parseSensorId(search) {
  let d = '';
  try { d = (new URLSearchParams(String(search || '')).get('d') || '').trim().toUpperCase(); } catch (e) { return null; }
  const m = /^(?:PROCOM-SENSOR-)?([0-9A-F]{12})$/.exec(d);
  return m ? { name: SENSOR_NAME_PREFIX + m[1], mac: m[1] } : null;
}
export function parseQuery(search) {
  const p = new URLSearchParams(String(search || ''));
  return { demo: p.get('demo') === 'fast' ? 'fast' : p.get('demo') === '1' ? 'normal' : '', debug: p.get('debug') === '1', rtc: p.get('rtc') === '1', sensor: parseSensorId(search) };
}

// ---------------------------------------------------------------- time and position
// Phone clock for login and fill commands: unix seconds and minutes east of UTC (Date gives minutes WEST).
export function phoneClock(nowMs, getTimezoneOffsetMin) {
  const tz = Math.round(-getTimezoneOffsetMin);
  return { t: Math.floor(nowMs / 1000), tz_min: Math.max(-840, Math.min(840, tz)) };
}
// The sensor's own clock (PROTOCOL.md 4.5, the `clock` reply or the reply of `maint_time`) compared with this phone's. r: the reply;
// phoneMs: this phone's clock when the sensor read its own (the middle of the request). Whole seconds: the sensor's `utc` is cut off at
// the second, so half a second is added back. diffS is the sensor's time minus the phone's (positive: the sensor is ahead); null when
// the sensor does not know the time. "Set" means `valid` is not false and `utc` is a time: a reply from before the field `valid`
// existed has none, and then `utc` alone decides.
export function clockInfo(r, phoneMs) {
  const o = r || {};
  const utc = Number.isInteger(o.utc) && o.utc > 0 && o.valid !== false ? o.utc : null;
  return {
    set: utc !== null,
    utc,
    src: utc === null ? 'none' : (o.src === 'rtc' || o.src === 'phone' ? o.src : 'other'),
    rtc: o.rtc === true,
    diffS: utc === null || !fin(phoneMs) ? null : Math.round(utc + 0.5 - phoneMs / 1000),
  };
}
export const CLOCK_SAME_S = 5;       // closer than this counts as "the same time" (Bluetooth delay and the whole-second clock)
// How far the sensor is from this phone, in plain words ("About 3 min behind this phone.").
export function clockDiffText(diffS) {
  if (!fin(diffS)) return '';
  const a = Math.abs(Math.round(diffS));
  if (a < CLOCK_SAME_S) return STR.clkSame;
  return t(diffS > 0 ? 'clkAhead' : 'clkBehind', { d: fmtDuration(a) });
}
// The "Source: ..." line for the card.
export function clockSrcText(c) {
  return t('clkSrc', { s: STR[c.set ? 'clkSrc_' + c.src : c.rtc ? 'clkSrc_none_rtc' : 'clkSrc_none'] });
}

const EARTH_R = 6371008.8;
export function haversineM(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
}
export function round6(x) { return Math.round(x * 1e6) / 1e6; }
export function validLatLon(lat, lon) {
  return fin(lat) && fin(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}
// A position fix is "weak" when its reported accuracy is worse than 50 m (site location).
export function fixIsWeak(acc) { return !fin(acc) || acc > LOC_WARN_M; }

// ---------------------------------------------------------------- maintenance input
export function parseDim(s) {
  s = String(s == null ? '' : s).trim().replace(',', '.');
  if (!s) return { ok: false, err: 'empty' };
  if (!/^(\d{1,6}(\.\d*)?|\.\d+)$/.test(s)) return { ok: false, err: 'num' };
  const v = Math.round(parseFloat(s) * 10) / 10;
  if (!(v >= DIM_MIN && v <= DIM_MAX)) return { ok: false, err: 'range', v };
  return { ok: true, v };
}
export function validateTank(l, w, h) {
  const r = { l: parseDim(l), w: parseDim(w), h: parseDim(h) };
  r.ok = r.l.ok && r.w.ok && r.h.ok;
  if (r.l.ok && r.w.ok) {
    r.lpmm = r.l.v * r.w.v / 1e6;
    if (r.h.ok) r.cap = r.h.v * r.lpmm;
  }
  return r;
}
// Site ID (PROTOCOL.md maint_site): up to 16 characters, letters, digits, space and - _ . / only, the first a letter or a digit and the
// last not a space. That also keeps spreadsheet formulas (a cell starting with = + - @) out of the CSV. Spaces and other white space at
// either end are removed first (a phone keyboard likes to add one after a word), so the value that is sent never ends in a space.
// Empty is allowed here (it means "clear"); the screen asks for an explicit Clear.
const SITE_ID_CHARS = /^[A-Za-z0-9 _./-]*$/;
export function validateSiteId(text) {
  const s = String(text == null ? '' : text).trim();
  const errs = [];
  if (s.length > SITE_ID_MAX) errs.push('long');
  if (!SITE_ID_CHARS.test(s)) errs.push('char');
  else if (s.length && !/^[A-Za-z0-9]/.test(s)) errs.push('first');
  if (errs.length) return { ok: false, err: errs[0], errs, value: s };
  return { ok: true, empty: s === '', value: s };
}
export function resetPhraseOk(s) { return String(s == null ? '' : s).trim().toUpperCase() === 'RESET'; }

// Challenge "FS-XXXXX-...-XX" -> groups that keep their dashes, so a selection copies the exact text.
export function codeGroups(c) {
  const a = String(c || '').split('-');
  return a.map((g, i) => (i < a.length - 1 ? g + '-' : g));
}
// Response check: 104 Crockford symbols. The sensor decodes leniently (case, '-', spaces, O->0, I/L->1); this only warns
// before a wasted attempt, and pulls the code out of a pasted message when it can.
const RESP_SEP = /[-\s\u00ad\u200b-\u200d\u2010-\u2015\u2060\u2212\ufe58\ufe63\uff0d\ufeff]/g;
export function respNorm(s) { return String(s || '').toUpperCase().replace(RESP_SEP, '').replace(/O/g, '0').replace(/[IL]/g, '1'); }
function respCount(n) {
  let good = 0, bad = 0;
  for (let i = 0; i < n.length; i++) {
    if (B32.indexOf(n.charAt(i)) >= 0) good++; else bad++;
  }
  return { good, bad };
}
export function respCheck(s) {
  const raw = String(s || '').trim(), c = respCount(respNorm(raw));
  if (c.good === 104 && !c.bad) return { ok: true, code: raw, n: 104, bad: 0 };
  const m = /(?:^|[^0-9A-Za-z])([0-9A-Za-z]{4}(?:[-\s\u00ad\u200b-\u200d\u2010-\u2015\u2060\u2212\ufe58\ufe63\uff0d\ufeff]+[0-9A-Za-z]{4}){25}|[0-9A-Za-z]{104})(?![0-9A-Za-z])/.exec(raw);
  if (m) {
    const c2 = respCount(respNorm(m[1]));
    if (c2.good === 104 && !c2.bad) return { ok: true, code: m[1], n: 104, bad: 0, extracted: true };
  }
  return { ok: false, code: raw, n: c.good, bad: c.bad };
}
// auth_response error code -> message key (+ lockout seconds when the reply says so).
export function loginErrorKey(code) {
  if (code === 'locked') return 'lg_locked';
  if (code === 'no_challenge') return 'lg_noChal';
  if (code === 'format') return 'lg_format';
  return 'lg_wrong';
}

// Plain-language text for any failure of a request (ProtocolError, timeout, lost connection). Duck-typed, no imports.
export function errText(e) {
  if (!e) return STR.errNet;
  if (e.name === 'ProtocolError') {
    const k = 'e_' + e.code;
    if (STR[k] !== undefined) return STR[k];
    return t('e_other', { m: e.msg || e.code || '?' });
  }
  if (e.name === 'DisconnectedError') return STR.errGone;
  return STR.errNet;
}

// ---------------------------------------------------------------- firmware package (.fwpkg)
export function verParse(s) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(s == null ? '' : s).trim());
  return m ? ((+m[1] & 0xffff) * 65536 + (+m[2] & 0xff) * 256 + (+m[3] & 0xff)) : -1;
}
export function verStr(u) { return fin(u) && u >= 0 ? Math.floor(u / 65536) + '.' + ((u >>> 8) & 0xff) + '.' + (u & 0xff) : ''; }

export const FWPKG_HEADER = 128;   // header bytes parsed here; a 64-byte signature follows (192 bytes before the image)
// .fwpkg header: 128 bytes, little-endian (unchanged from 1.2).
export function parseFwpkgHeader(b) {
  if (!b || b.length < 128) return { ok: false, err: 'short' };
  let s = '';
  for (let i = 0; i < 8; i++) s += String.fromCharCode(b[i]);
  if (s !== 'MRMFWPK1') return { ok: false, err: 'magic' };
  const u16 = (o) => b[o] | b[o + 1] << 8;
  const u32 = (o) => (b[o] | b[o + 1] << 8 | b[o + 2] << 16 | b[o + 3] << 24) >>> 0;
  if (u16(8) !== 1 || u16(10) !== 128) return { ok: false, err: 'header' };
  const prod = 'MRM-FUEL';
  for (let i = 0; i < 16; i++) {
    if (b[12 + i] !== (i < prod.length ? prod.charCodeAt(i) : 0)) return { ok: false, err: 'product' };
  }
  if (u16(30) !== 0) return { ok: false, err: 'reserved' };               // flags: none are defined
  for (let i = 84; i < 128; i++) {
    if (b[i]) return { ok: false, err: 'reserved' };
  }
  let sha = '', git = '';
  for (let i = 40; i < 72; i++) sha += (b[i] < 16 ? '0' : '') + b[i].toString(16);
  for (let i = 76; i < 84 && b[i]; i++) git += String.fromCharCode(b[i]);
  const v = u32(32), size = u32(36);
  return {
    ok: true, chipId: b[28], variantId: b[29], variant: b[29] === 0 ? 'production' : b[29] === 1 ? 'debug' : 'unknown',
    flags: u16(30), versionU32: v, version: verStr(v), imageSize: size, sha256: sha, built: u32(72), git,
    total: 192 + size
  };
}
// Pre-checks before anything is sent (the sensor repeats them and decides; this saves the transfer time). They are the sensor's own
// header rules (core/fwpkg.cpp pkg_check_prefix): the right chip, a known variant, not older than the running version unless the
// approval allows it, an image of at least 64 bytes that fits the update area. A debug package on a production sensor, or the
// other way round, is allowed (Procom decides which signed package a customer gets): it only gets a warning. The signature is
// not checked here. dev = {fw, chip, variant} from hello; slotBytes = maint_state.ota.slot_bytes (0 or missing: unknown).
export function checkPackage(h, fileSize, dev, grant, slotBytes) {
  const errs = [], warns = [];
  dev = dev || {};
  grant = grant || {};
  if (!h || !h.ok) return { ok: false, errs: ['notpkg'], warns };
  const ids = { esp32: 0, esp32c3: 5 };
  if (dev.chip !== undefined && ids[dev.chip] !== h.chipId) errs.push('chip');
  if (h.variantId > 1) errs.push('variant');                 // any board takes debug and production; only an unknown value is refused
  const cur = verParse(dev.fw);
  if (cur >= 0 && h.versionU32 < cur) {
    if (grant.older) warns.push('older'); else errs.push('older');
  }
  if (cur >= 0 && h.versionU32 === cur) warns.push('same');
  const slot = fin(slotBytes) && slotBytes > 0 ? slotBytes : 0;
  if (h.imageSize < 64) errs.push('size');
  else if (slot && (h.imageSize > slot || fileSize > slot + 192)) errs.push('big');          // the image goes into the area; 192 bytes of header and signature do not
  if (fileSize !== h.total && !errs.includes('size')) errs.push('size');
  if (h.variantId <= 1 && dev.variant && h.variant !== dev.variant) warns.push('variant');
  return { ok: errs.length === 0, errs, warns };
}
// "ESP32-C3 - production - version 2.0.1": what the chosen file is, from its header.
export function fwSummary(h) { return t('fwSummary', { chip: chipName(h.chipId), variant: h.variant, v: h.version }); }
// The sensor's ota_err / ota_end error code -> words.
export function otaReason(code) { return STR['ota_' + code] || (code ? String(code) : STR.na); }

// ---------------------------------------------------------------- fill reports
// The operator's litres: 0-100000 L, 2 decimals at most.
export function parseLitres(s) {
  s = String(s == null ? '' : s).trim().replace(',', '.');
  if (!/^(\d{1,6}(\.\d{0,2})?|\.\d{1,2})$/.test(s)) return { ok: false };
  const v = parseFloat(s);
  return v >= 0 && v <= 100000 ? { ok: true, v } : { ok: false };
}
// Bit 2 is unused in 2.0; bits 9 to 15 are not defined yet and are ignored (PROTOCOL.md 6.2).
const FLAG_BITS = [0, 1, 3, 4, 5, 6, 7, 8];
export function fillFlagNames(flags) {
  const out = [];
  for (const i of FLAG_BITS) if ((flags >>> i) & 1) out.push(STR['frf_' + i]);
  return out;
}
export function fillShareText(rep) { return rep.line + '\n' + rep.code; }
export function waUrl(rep) { return 'https://wa.me/?text=' + encodeURIComponent(fillShareText(rep)); }
// "14 Oct 14:05–14:20" in the phone's time zone at Start (tz_min east of UTC).
export function fillWhen(r) {
  if (!r || !fin(r.phone_start) || r.phone_start <= 0) return STR.frTimeNA;
  const tz = fin(r.tz_min) ? r.tz_min : 330;
  const f = (u) => {
    const d = new Date((u + tz * 60) * 1000);
    return { day: d.getUTCDate() + ' ' + STR.months[d.getUTCMonth()], hm: pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) };
  };
  const a = f(r.phone_start), b = r.phone_end > 0 ? f(r.phone_end) : null;
  return a.day + ' ' + a.hm + (b ? '–' + (b.day === a.day ? '' : b.day + ' ') + b.hm : '');
}
export function fillL(x) { return fin(x) ? fmtNum(x, 1) + ' L' : STR.frNotEntered; }
export function fillFigs(r) { return t('frFigs', { o: fillL(r.operator_l) }); }
// The on-screen line hides the sensor's own litres and the warning flags (they stay in the signed code for customer IT).
// " · sensor N.N L" is always this exact shape; " · flags: ..." is always last when present.
export function fillLineDisplay(line) {
  return (line || '').replace(/ · sensor \d+\.\d+ L/, '').replace(/ · flags:.*$/, '');
}
export function fillErrText(e) {
  if (e && e.name === 'ProtocolError') {
    const k = 'fre_' + e.code;
    if (STR[k] !== undefined) return STR[k];
  }
  return errText(e);
}
