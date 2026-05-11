' HomeScene.brs - CustomCuts Stream
'
' Phase 2:
'  - Host URL is read from roRegistry on launch; if missing, a KeyboardDialog
'    prompts for it and persists the result.
'  - A Timer + CommandTask polls /commands?since=<seq> every 1s and dispatches
'    remote-control commands (next, prev, seek_delta, pause, resume, etc).
'  - A Timer + EventTask posts the current playback state to /events every 2s
'    (plus immediate posts on state changes and queue advances).

sub init()
    m.top.backgroundURI = ""
    m.top.backgroundColor = "0x000000FF"

    m.titleLabel = m.top.findNode("titleLabel")
    m.statusLabel = m.top.findNode("statusLabel")
    m.queueList = m.top.findNode("queueList")
    m.featuredRows = m.top.findNode("featuredRows")
    m.videoPlayer = m.top.findNode("videoPlayer")
    m.queueTask = m.top.findNode("queueTask")
    m.cmdTask = m.top.findNode("cmdTask")
    m.eventTask = m.top.findNode("eventTask")
    m.discoveryTask = m.top.findNode("discoveryTask")
    m.featuredTask = m.top.findNode("featuredTask")
    m.postCommandTask = m.top.findNode("postCommandTask")
    m.cmdTimer = m.top.findNode("cmdTimer")
    m.eventTimer = m.top.findNode("eventTimer")
    m.progressGroup = m.top.findNode("progressGroup")
    m.progressBarFill = m.top.findNode("progressBarFill")
    m.progressTimeLabel = m.top.findNode("progressTimeLabel")
    m.qrOverlay = m.top.findNode("qrOverlay")
    m.qrPoster = m.top.findNode("qrPoster")
    m.qrUrlLabel = m.top.findNode("qrUrlLabel")
    m.seekOverlay = m.top.findNode("seekOverlay")
    m.seekTitleLabel = m.top.findNode("seekTitleLabel")
    m.seekTimeLabel = m.top.findNode("seekTimeLabel")
    m.seekPctLabel = m.top.findNode("seekPctLabel")
    m.seekBarFill = m.top.findNode("seekBarFill")
    m.seekHideTimer = m.top.findNode("seekHideTimer")
    m.annotationOverlay = m.top.findNode("annotationOverlay")

    m.queue = []
    m.currentIndex = -1
    m.cutsState = invalid
    m.annotations = []
    m.annSlots = []
    initAnnotationSlots()
    m.commandSeq = 0
    m.hostDialog = invalid
    m.lastReportedState = ""
    m.hostUrl = ""
    m.authToken = ""
    m.queueFailureCount = 0
    m.commandFailureCount = 0
    m.playlists = []
    m.playlistMode = false
    m.connected = false
    m.connectTimer = m.top.findNode("connectTimer")

    m.queueList.observeField("itemSelected", "onQueueItemSelected")
    m.featuredRows.observeField("rowItemSelected", "onFeaturedSelected")
    m.videoPlayer.observeField("state", "onVideoState")
    m.videoPlayer.observeField("position", "onVideoPosition")
    m.queueTask.observeField("result", "onQueueFetched")
    m.cmdTask.observeField("result", "onCommandsFetched")
    m.featuredTask.observeField("result", "onFeaturedFetched")
    m.discoveryTask.observeField("done", "onDiscoveryDone")
    m.cmdTimer.observeField("fire", "onCmdTimer")
    m.eventTimer.observeField("fire", "onEventTimer")
    m.connectTimer.observeField("fire", "onConnectTimeout")
    m.seekHideTimer.observeField("fire", "onSeekHideTimer")
    m.videoPlayer.enableTrickPlay = false

    m.top.setFocus(true)

    ' Default host/token, plus the build stamp this zip was packaged with.
    ' build.py rewrites all three values per build (LAN IP, current host
    ' token, unix timestamp). When the embedded DEFAULT_BUILD differs from
    ' the build the registry was last initialized against, we overwrite
    ' hostUrl + authToken with the fresh defaults -- keeping every sideload
    ' aligned with whatever token the dev host currently uses, instead of
    ' silently reusing a stale one from a previous install.
    DEFAULT_HOST = "http://192.168.254.76:8787"
    DEFAULT_TOKEN = "7b7ff70ab148f759487a7083eff1e497"
    DEFAULT_BUILD = "0"

    savedBuild = loadBuildStamp()
    if savedBuild <> DEFAULT_BUILD then
        print "build stamp changed ("; savedBuild; " -> "; DEFAULT_BUILD; "), resetting host/token to packaged defaults"
        saveHostUrl(DEFAULT_HOST)
        saveAuthToken(DEFAULT_TOKEN)
        saveBuildStamp(DEFAULT_BUILD)
    end if

    m.hostUrl = loadHostUrl()
    m.authToken = loadAuthToken()
    if m.hostUrl = "" then
        m.hostUrl = DEFAULT_HOST
        m.authToken = DEFAULT_TOKEN
        saveHostUrl(DEFAULT_HOST)
        saveAuthToken(DEFAULT_TOKEN)
    end if

    m.statusLabel.text = "Connecting to " + m.hostUrl + "..."
    m.connectTimer.control = "start"
    startPollers()
    fetchQueue()
    fetchFeatured()
end sub

sub onConnectTimeout()
    if m.connected then return
    m.statusLabel.text = "Connection timed out. Enter host manually."
    showHostSetup(m.hostUrl)
end sub

' Featured rows ----------------------------------------------------------
sub fetchFeatured()
    m.featuredTask.hostUrl = m.hostUrl
    m.featuredTask.authToken = m.authToken
    m.featuredTask.control = "RUN"
end sub

sub onFeaturedFetched()
    result = m.featuredTask.result
    if result = invalid then return
    if result.error <> invalid and result.error <> "" then
        print "featured fetch error: "; result.error
        return
    end if

    classics = result.classics
    incoming = result.incoming
    if classics = invalid then classics = []
    if incoming = invalid then incoming = []

    ' Build the RowList content: one row per bucket, each row's children
    ' are ContentNodes with title + HDPosterUrl pointing to /thumbs/*.jpg.
    root = CreateObject("roSGNode", "ContentNode")

    classicsRow = root.createChild("ContentNode")
    classicsRow.title = "Featured — Classics"
    populateFeaturedRow(classicsRow, classics)

    incomingRow = root.createChild("ContentNode")
    incomingRow.title = "Featured — Incoming"
    populateFeaturedRow(incomingRow, incoming)

    m.featuredRows.content = root
    if classics.count() > 0 or incoming.count() > 0 then
        m.featuredRows.visible = true
    end if
end sub

sub populateFeaturedRow(rowNode as object, items as object)
    for i = 0 to items.count() - 1
        e = items[i]
        node = rowNode.createChild("ContentNode")
        node.title = e.title
        if e.thumb_url <> invalid and e.thumb_exists = true then
            node.HDPosterUrl = e.thumb_url
            node.SDPosterUrl = e.thumb_url
        end if
    end for
end sub

sub onFeaturedSelected()
    sel = m.featuredRows.rowItemSelected
    if sel = invalid then return
    rowIdx = sel[0]
    colIdx = sel[1]

    bucket = "classics"
    if rowIdx = 1 then bucket = "incoming"

    args = "{""bucket"":""" + bucket + """,""start_index"":" + colIdx.toStr() + "}"
    postRemoteCommand("load_featured", args)
    m.statusLabel.text = "Loading featured " + bucket + " from #" + (colIdx + 1).toStr() + "..."
end sub

' LAN discovery -----------------------------------------------------------
sub runDiscovery()
    m.statusLabel.text = "Searching for CustomCuts host on LAN..."
    m.discoveryTask.timeoutMs = 3000
    m.discoveryTask.control = "RUN"
end sub

' Phase 4: host unreachable → drop stored URL/token and re-discover.
' Thresholds: 3 consecutive /queue.json failures OR 10 consecutive
' /commands poll failures (10 * ~1s = ~10s of silence).
sub noteQueueFailure()
    m.queueFailureCount = m.queueFailureCount + 1
    if m.queueFailureCount >= 3 then
        triggerRediscovery("queue fetch")
    end if
end sub

sub noteCommandFailure()
    m.commandFailureCount = m.commandFailureCount + 1
    if m.commandFailureCount >= 10 then
        triggerRediscovery("command poll")
    end if
end sub

sub triggerRediscovery(reason as string)
    print "re-discovery triggered by: "; reason
    m.cmdTimer.control = "stop"
    m.eventTimer.control = "stop"
    m.videoPlayer.control = "stop"
    m.videoPlayer.visible = false
    m.progressGroup.visible = false
    m.hostUrl = ""
    m.authToken = ""
    saveHostUrl("")
    saveAuthToken("")
    m.queueFailureCount = 0
    m.commandFailureCount = 0
    m.statusLabel.text = "Host unreachable (" + reason + ") - searching again..."
    runDiscovery()
end sub

sub onDiscoveryDone()
    if not m.discoveryTask.done then return
    found = m.discoveryTask.result
    if found <> invalid and found <> "" then
        saveHostUrl(found)
        m.hostUrl = found
        tok = m.discoveryTask.authToken
        if tok <> invalid and tok <> "" then
            m.authToken = tok
            saveAuthToken(tok)
        end if
        m.statusLabel.text = "Host discovered: " + found
        m.queueFailureCount = 0
        m.commandFailureCount = 0
        startPollers()
        fetchQueue()
        fetchFeatured()
    else
        m.statusLabel.text = "No host found. Enter address manually."
        showHostSetup("192.168.1.100:8787")
    end if
end sub

' Host URL + auth token persistence ---------------------------------------
function loadHostUrl() as string
    reg = CreateObject("roRegistrySection", "CustomCuts")
    if reg.Exists("hostUrl") then return reg.Read("hostUrl")
    return ""
end function

sub saveHostUrl(url as string)
    reg = CreateObject("roRegistrySection", "CustomCuts")
    reg.Write("hostUrl", url)
    reg.Flush()
end sub

function loadAuthToken() as string
    reg = CreateObject("roRegistrySection", "CustomCuts")
    if reg.Exists("authToken") then return reg.Read("authToken")
    return ""
end function

sub saveAuthToken(tok as string)
    reg = CreateObject("roRegistrySection", "CustomCuts")
    reg.Write("authToken", tok)
    reg.Flush()
end sub

function loadBuildStamp() as string
    reg = CreateObject("roRegistrySection", "CustomCuts")
    if reg.Exists("buildStamp") then return reg.Read("buildStamp")
    return ""
end function

sub saveBuildStamp(stamp as string)
    reg = CreateObject("roRegistrySection", "CustomCuts")
    reg.Write("buildStamp", stamp)
    reg.Flush()
end sub

sub showHostSetup(initialText as string)
    kbd = CreateObject("roSGNode", "KeyboardDialog")
    kbd.title = "CustomCuts Host"
    kbd.message = "IP:PORT|TOKEN (e.g. 192.168.1.42:8787|abc123). Paste from extension Cast panel."
    kbd.text = initialText
    kbd.buttons = ["Connect", "Cancel"]
    kbd.observeField("buttonSelected", "onHostDialogButton")
    m.hostDialog = kbd
    m.top.dialog = kbd
end sub

sub onHostDialogButton()
    idx = m.hostDialog.buttonSelected
    if idx = 0 then
        raw = m.hostDialog.text
        parsed = parseHostEntry(raw)
        saveHostUrl(parsed.url)
        m.hostUrl = parsed.url
        if parsed.token <> "" then
            m.authToken = parsed.token
            saveAuthToken(parsed.token)
        end if
        m.top.dialog = invalid
        m.hostDialog = invalid
        m.statusLabel.text = "Host saved: " + parsed.url
        m.queueFailureCount = 0
        m.commandFailureCount = 0
        startPollers()
        fetchQueue()
        fetchFeatured()
    else
        m.top.dialog = invalid
        m.hostDialog = invalid
        m.statusLabel.text = "Setup cancelled. Relaunch to retry."
    end if
end sub

function parseHostEntry(raw as string) as object
    s = raw
    while len(s) > 0 and (right(s, 1) = " " or right(s, 1) = chr(9))
        s = left(s, len(s) - 1)
    end while
    while len(s) > 0 and (left(s, 1) = " " or left(s, 1) = chr(9))
        s = mid(s, 2)
    end while
    token = ""
    pipe = Instr(1, s, "|")
    if pipe > 0 then
        token = mid(s, pipe + 1)
        s = left(s, pipe - 1)
    end if
    if lCase(left(s, 7)) <> "http://" and lCase(left(s, 8)) <> "https://" then
        s = "http://" + s
    end if
    return { url: s, token: token }
end function

' Queue fetching + list ---------------------------------------------------
sub startPollers()
    m.cmdTimer.control = "start"
    m.eventTimer.control = "start"
end sub

sub fetchQueue()
    m.statusLabel.text = "Fetching queue from " + m.hostUrl + "..."
    m.queueTask.hostUrl = m.hostUrl
    m.queueTask.authToken = m.authToken
    m.queueTask.control = "RUN"
end sub

sub onQueueFetched()
    result = m.queueTask.result
    if result = invalid then
        m.statusLabel.text = "Fetch failed: no response."
        noteQueueFailure()
        return
    end if
    if result.error <> invalid and result.error <> "" then
        m.statusLabel.text = "Fetch failed: " + result.error
        noteQueueFailure()
        return
    end if
    if result.queue = invalid then
        m.statusLabel.text = "Fetch failed: missing queue field in response."
        noteQueueFailure()
        return
    end if

    m.queueFailureCount = 0
    m.connected = true
    m.connectTimer.control = "stop"
    m.queue = result.queue

    m.playlistMode = false
    renderQueueList()
end sub

sub renderQueueList()
    ' Build the LabelList content:
    '   [0] Change Host
    '   [1] Browse Playlists
    '   [2] Show QR Code
    '   [3..] queue items
    items = CreateObject("roSGNode", "ContentNode")
    changeHostItem = items.createChild("ContentNode")
    changeHostItem.title = "[Change Host]"
    playlistItem = items.createChild("ContentNode")
    playlistItem.title = "[Browse Playlists]"
    qrItem = items.createChild("ContentNode")
    qrItem.title = "[Show QR Code]"
    for i = 0 to m.queue.count() - 1
        entry = m.queue[i]
        item = items.createChild("ContentNode")
        item.title = entry.title
    end for
    m.queueList.content = items
    m.queueList.visible = true
    m.queueList.setFocus(true)

    if m.queue.count() = 0 then
        m.statusLabel.text = "Queue is empty. Browse playlists or use the extension."
    else
        m.statusLabel.text = m.queue.count().toStr() + " videos in queue. Press OK to play."
    end if
end sub

sub onQueueItemSelected()
    idx = m.queueList.itemSelected

    if m.playlistMode then
        handlePlaylistSelection(idx)
        return
    end if

    if idx = 0 then
        showHostSetup(m.hostUrl)
        return
    end if
    if idx = 1 then
        showPlaylistPicker()
        return
    end if
    if idx = 2 then
        showQrCode()
        return
    end if
    playIndex(idx - 3)
end sub

' Playlist picker ---------------------------------------------------------
sub showPlaylistPicker()
    m.statusLabel.text = "Fetching playlists..."
    m.queueTask.hostUrl = m.hostUrl
    m.queueTask.authToken = m.authToken

    req = CreateObject("roUrlTransfer")
    req.setUrl(m.hostUrl + "/playlists.json")
    req.setCertificatesFile("common:/certs/ca-bundle.crt")
    req.initClientCertificates()
    req.retainBodyOnError(true)
    req.addHeader("Accept", "application/json")
    if m.authToken <> invalid and m.authToken <> "" then
        req.addHeader("X-CC-Auth", m.authToken)
    end if

    ' This runs on the render thread so it blocks briefly — acceptable for
    ' a short JSON fetch. Tasks can't easily return to a callback flow here
    ' because we need to swap the list synchronously.
    body = req.getToString()
    if body = invalid or body = "" then
        m.statusLabel.text = "Couldn't load playlists."
        return
    end if
    parsed = ParseJson(body)
    if parsed = invalid or parsed.playlists = invalid then
        m.statusLabel.text = "Couldn't parse playlists."
        return
    end if

    m.playlists = parsed.playlists
    m.playlistMode = true

    items = CreateObject("roSGNode", "ContentNode")
    backItem = items.createChild("ContentNode")
    backItem.title = "[Back to Queue]"
    for i = 0 to m.playlists.count() - 1
        pl = m.playlists[i]
        item = items.createChild("ContentNode")
        plName = pl.name
        if plName = invalid or plName = "" then plName = "(untitled)"
        plCount = 0
        if pl.video_count <> invalid then plCount = pl.video_count
        item.title = plName + "  (" + plCount.toStr() + " videos)"
    end for

    ' Add shuffle variants
    for i = 0 to m.playlists.count() - 1
        pl = m.playlists[i]
        item = items.createChild("ContentNode")
        plName = pl.name
        if plName = invalid or plName = "" then plName = "(untitled)"
        item.title = plName + "  [Shuffle]"
    end for

    m.queueList.content = items
    m.queueList.visible = true
    m.queueList.setFocus(true)
    m.statusLabel.text = m.playlists.count().toStr() + " playlists available."
end sub

sub handlePlaylistSelection(idx as integer)
    if idx = 0 then
        m.playlistMode = false
        renderQueueList()
        return
    end if

    plCount = m.playlists.count()

    if idx >= 1 and idx <= plCount then
        ' Normal (unshuffled) playlist selection
        plIdx = idx - 1
        pl = m.playlists[plIdx]
        plIndex = plIdx
        if pl.index <> invalid then plIndex = pl.index
        m.statusLabel.text = "Loading " + pl.name + "..."
        postRemoteCommand("load_playlist", "{""index"":" + plIndex.toStr() + "}")
        m.playlistMode = false
        return
    end if

    if idx > plCount and idx <= plCount * 2 then
        ' Shuffle selection
        plIdx = idx - plCount - 1
        pl = m.playlists[plIdx]
        plIndex = plIdx
        if pl.index <> invalid then plIndex = pl.index
        m.statusLabel.text = "Loading " + pl.name + " (shuffled)..."
        postRemoteCommand("load_playlist_shuffled", "{""index"":" + plIndex.toStr() + "}")
        m.playlistMode = false
        return
    end if
end sub

sub postRemoteCommand(cmdName as string, argsJson as string)
    m.postCommandTask.hostUrl = m.hostUrl
    m.postCommandTask.authToken = m.authToken
    m.postCommandTask.cmdName = cmdName
    m.postCommandTask.argsJson = argsJson
    m.postCommandTask.control = "RUN"
end sub

sub playIndex(idx as integer)
    if idx < 0 or idx >= m.queue.count() then return
    m.currentIndex = idx
    entry = m.queue[idx]

    m.cutsState = buildCutsState(entry)
    setAnnotationsForCurrentVideo(entry.annotations)

    content = CreateObject("roSGNode", "ContentNode")
    content.url = entry.play_url
    content.title = entry.title
    content.streamFormat = "mp4"

    m.videoPlayer.content = content
    m.videoPlayer.visible = true

    if m.cutsState.startSeek > 0 then
        m.videoPlayer.seek = m.cutsState.startSeek
    end if

    m.videoPlayer.control = "play"
    m.videoPlayer.setFocus(true)
    m.statusLabel.text = "Playing: " + entry.title
    m.progressBarFill.width = 0
    m.progressTimeLabel.text = "0:00 / 0:00"
    m.progressGroup.visible = true
    reportEvent("playback_started")
end sub

function formatTimeSec(sec as float) as string
    if sec < 0 then sec = 0
    total = Int(sec)
    mm = total \ 60
    ss = total mod 60
    if ss < 10 then
        return mm.toStr() + ":0" + ss.toStr()
    end if
    return mm.toStr() + ":" + ss.toStr()
end function

function buildCutsState(entry as object) as object
    state = {
        mode: "normal",
        skip: [],
        only: [],
        loop: [],
        actionStart: invalid,
        actionEnd: invalid,
        startSeek: 0,
        queueEndTime: -1,
        queueEndTriggered: false
    }
    if entry.cuts = invalid then return state
    c = entry.cuts
    if c.mode <> invalid then state.mode = c.mode
    if c.skip <> invalid then state.skip = c.skip
    if c.only <> invalid then state.only = c.only
    if c.loop <> invalid then state.loop = c.loop
    state.actionStart = c.actionStart
    state.actionEnd = c.actionEnd

    startMode = "B"
    endMode = "0"
    if c.startMode <> invalid then startMode = c.startMode
    if c.endMode <> invalid then endMode = c.endMode

    if startMode = "A1" and state.actionStart <> invalid then
        state.startSeek = state.actionStart.start
    else if startMode = "A2" and state.actionStart <> invalid then
        state.startSeek = state.actionStart.end
    end if

    if endMode = "E1" and state.actionEnd <> invalid then
        state.queueEndTime = state.actionEnd.start
    else if endMode = "E2" and state.actionEnd <> invalid then
        state.queueEndTime = state.actionEnd.end
    end if

    return state
end function

' Annotations (HUD-style timestamped text comments) ----------------------
' Pool of pre-allocated slots to avoid per-frame node allocation.
' Each slot is a Group containing a Rectangle (background) and a Label.
' Annotations beyond ANN_MAX_SLOTS are silently dropped per-frame.
sub initAnnotationSlots()
    ANN_MAX_SLOTS = 16
    for i = 0 to ANN_MAX_SLOTS - 1
        slot = m.annotationOverlay.createChild("Group")
        slot.visible = false
        bg = slot.createChild("Rectangle")
        bg.color = "0x000000CC"
        lbl = slot.createChild("Label")
        lbl.color = "0xFFFFFFFF"
        lbl.font = "font:MediumSystemFont"
        lbl.horizAlign = "left"
        lbl.vertAlign = "top"
        lbl.wrap = true
        m.annSlots.push({ slot: slot, bg: bg, lbl: lbl })
    end for
end sub

sub setAnnotationsForCurrentVideo(rawAnns as object)
    m.annotations = []
    if rawAnns = invalid then
        hideAllAnnotations()
        return
    end if
    if type(rawAnns) <> "roArray" then
        hideAllAnnotations()
        return
    end if
    for each a in rawAnns
        if a <> invalid then m.annotations.push(a)
    end for
    if m.annotations.count() = 0 then hideAllAnnotations()
end sub

sub updateAnnotations(curPos as float)
    if m.annotations.count() = 0 then return
    if not m.videoPlayer.visible then
        m.annotationOverlay.visible = false
        return
    end if

    activeIdx = 0
    for each ann in m.annotations
        if activeIdx >= m.annSlots.count() then exit for
        if ann <> invalid then
            s = 0
            e = 0
            if ann.startTime <> invalid then s = ann.startTime
            if ann.endTime <> invalid then e = ann.endTime
            if curPos >= s and curPos <= e then
                applyAnnotationToSlot(m.annSlots[activeIdx], ann)
                activeIdx = activeIdx + 1
            end if
        end if
    end for

    for i = activeIdx to m.annSlots.count() - 1
        m.annSlots[i].slot.visible = false
    end for

    m.annotationOverlay.visible = (activeIdx > 0)
end sub

sub hideAllAnnotations()
    for each s in m.annSlots
        s.slot.visible = false
    end for
    m.annotationOverlay.visible = false
end sub

sub applyAnnotationToSlot(s as object, ann as object)
    ' Field is named "box" in the JSON payload but `box` is a reserved word
    ' in brs-engine (the BrightScript Simulator). Use bracket access for the
    ' lookup and a non-reserved local name to keep the parser happy.
    rect = ann["box"]
    if rect = invalid then rect = { x: 0.35, y: 0.4, w: 0.3, h: 0.12 }

    bx = clampF(rect.x, 0, 1)
    by = clampF(rect.y, 0, 1)
    bw = clampF(rect.w, 0.04, 1)
    bh = clampF(rect.h, 0.03, 1)

    px = Int(bx * 1920)
    py = Int(by * 1080)
    pw = Int(bw * 1920)
    ph = Int(bh * 1080)

    style = ann.style
    bgHex = "#000000"
    bgOpacity = 80
    fgHex = "#ffffff"
    fontSize = 16
    if style <> invalid then
        if style.bgColor <> invalid then bgHex = style.bgColor
        if style.bgOpacity <> invalid then bgOpacity = style.bgOpacity
        if style.textColor <> invalid then fgHex = style.textColor
        if style.fontSize <> invalid then fontSize = style.fontSize
    end if

    s.slot.translation = [px, py]
    s.bg.width = pw
    s.bg.height = ph
    s.bg.color = hexRgbToRokuRgba(bgHex, bgOpacity)
    s.lbl.color = hexRgbToRokuRgba(fgHex, 100)
    s.lbl.translation = [12, 8]
    s.lbl.width = pw - 24
    s.lbl.height = ph - 16
    s.lbl.text = annText(ann)
    ' Roku 'font' field accepts a uri or built-in font ref. We approximate
    ' by picking a discrete built-in size based on annotation fontSize.
    if fontSize >= 28 then
        s.lbl.font = "font:SmallBoldSystemFont"
    else if fontSize >= 20 then
        s.lbl.font = "font:SmallestBoldSystemFont"
    else if fontSize >= 14 then
        s.lbl.font = "font:SmallestSystemFont"
    else
        s.lbl.font = "font:SmallestSystemFont"
    end if
    s.slot.visible = true
end sub

function annText(ann as object) as string
    if ann.text <> invalid then return ann.text
    return ""
end function

function clampF(v as dynamic, lo as float, hi as float) as float
    if v = invalid then return lo
    f = 0.0
    if type(v) = "Float" or type(v) = "roFloat" then
        f = v
    else if type(v) = "Double" or type(v) = "roDouble" then
        f = v
    else if type(v) = "Integer" or type(v) = "roInt" or type(v) = "roInteger" then
        f = v
    else
        return lo
    end if
    if f < lo then return lo
    if f > hi then return hi
    return f
end function

' "#rrggbb" + opacity 0..100 -> "0xRRGGBBAA"
function hexRgbToRokuRgba(hex as string, opacity as integer) as string
    if hex = invalid or len(hex) < 7 then return "0x000000FF"
    rr = upperHex(mid(hex, 2, 2))
    gg = upperHex(mid(hex, 4, 2))
    bb = upperHex(mid(hex, 6, 2))
    if opacity < 0 then opacity = 0
    if opacity > 100 then opacity = 100
    aInt = Int(opacity * 255 / 100)
    aHex = byteToHex(aInt)
    return "0x" + rr + gg + bb + aHex
end function

function upperHex(s as string) as string
    out = ""
    for i = 1 to len(s)
        c = mid(s, i, 1)
        ascC = Asc(c)
        if ascC >= 97 and ascC <= 102 then
            out = out + chr(ascC - 32)
        else
            out = out + c
        end if
    end for
    return out
end function

function byteToHex(n as integer) as string
    if n < 0 then n = 0
    if n > 255 then n = 255
    digits = "0123456789ABCDEF"
    hi = n \ 16
    lo = n mod 16
    return mid(digits, hi + 1, 1) + mid(digits, lo + 1, 1)
end function

' Video playback observers ------------------------------------------------
sub onVideoPosition()
    if m.cutsState = invalid then return
    curPos = m.videoPlayer.position
    updateAnnotations(curPos)

    ' Drive on-TV progress bar whenever position updates
    dur = m.videoPlayer.duration
    if dur > 0 then
        pct = curPos / dur
        if pct < 0 then pct = 0
        if pct > 1 then pct = 1
        m.progressBarFill.width = Int(1740 * pct)
        m.progressTimeLabel.text = formatTimeSec(curPos) + " / " + formatTimeSec(dur)
    end if

    if m.cutsState.queueEndTime > 0 and not m.cutsState.queueEndTriggered then
        if curPos >= m.cutsState.queueEndTime then
            m.cutsState.queueEndTriggered = true
            advanceQueue()
            return
        end if
    end if

    mode = m.cutsState.mode

    if mode = "skip" then
        for each r in m.cutsState.skip
            if curPos >= r.start and curPos < r.end then
                m.videoPlayer.seek = r.end
                return
            end if
        end for
        return
    end if

    if mode = "only" and m.cutsState.only.count() > 0 then
        inRange = false
        nextStart = -1
        for each r in m.cutsState.only
            if curPos >= r.start and curPos < r.end then
                inRange = true
                exit for
            end if
            if r.start > curPos then
                if nextStart < 0 or r.start < nextStart then nextStart = r.start
            end if
        end for
        if not inRange then
            if nextStart >= 0 then
                m.videoPlayer.seek = nextStart
            else
                advanceQueue()
            end if
        end if
        return
    end if

    if mode = "loop" and m.cutsState.loop.count() > 0 then
        inRange = false
        nextStart = -1
        for each r in m.cutsState.loop
            if curPos >= r.start and curPos < r.end then
                inRange = true
                exit for
            end if
            if r.start > curPos then
                if nextStart < 0 or r.start < nextStart then nextStart = r.start
            end if
        end for
        if not inRange then
            if nextStart >= 0 then
                m.videoPlayer.seek = nextStart
            else
                m.videoPlayer.seek = m.cutsState.loop[0].start
            end if
        end if
    end if
end sub

sub onVideoState()
    state = m.videoPlayer.state
    print "video state: "; state
    if state <> m.lastReportedState then
        reportEvent("state_change")
        m.lastReportedState = state
    end if
    if state = "finished" then
        advanceQueue()
    else if state = "error" then
        err = m.videoPlayer.errorCode
        m.statusLabel.text = "Playback error (code " + err.toStr() + "). Check host logs."
    end if
end sub

sub advanceQueue()
    nextIdx = m.currentIndex + 1
    if nextIdx < m.queue.count() then
        playIndex(nextIdx)
    else
        m.videoPlayer.control = "stop"
        m.videoPlayer.visible = false
        m.progressGroup.visible = false
        hideAllAnnotations()
        m.statusLabel.text = "Queue complete."
        m.queueList.setFocus(true)
        reportEvent("queue_complete")
    end if
end sub

sub previousQueue()
    if m.currentIndex > 0 then
        playIndex(m.currentIndex - 1)
    end if
end sub

' Command polling + dispatch ----------------------------------------------
sub onCmdTimer()
    if m.hostUrl = invalid or m.hostUrl = "" then return
    m.cmdTask.hostUrl = m.hostUrl
    m.cmdTask.authToken = m.authToken
    m.cmdTask.sinceSeq = m.commandSeq
    m.cmdTask.control = "RUN"
end sub

sub onCommandsFetched()
    result = m.cmdTask.result
    if result = invalid then
        noteCommandFailure()
        return
    end if
    if result.error <> invalid and result.error <> "" then
        noteCommandFailure()
        return
    end if
    m.commandFailureCount = 0
    if result.commands <> invalid and result.commands.count() > 0 then
        for each c in result.commands
            dispatchCommand(c)
            if c.seq <> invalid and c.seq > m.commandSeq then
                m.commandSeq = c.seq
            end if
        end for
    end if
    if result.next_seq <> invalid and result.next_seq > m.commandSeq then
        m.commandSeq = result.next_seq
    end if
end sub

sub dispatchCommand(c as object)
    cmd = c.cmd
    args = c.args
    if args = invalid then args = {}
    print "dispatch: "; cmd

    if cmd = "next" then
        advanceQueue()
    else if cmd = "prev" then
        previousQueue()
    else if cmd = "seek" then
        if args.position <> invalid then
            m.videoPlayer.seek = args.position
            showSeekOverlay(0)
        end if
    else if cmd = "seek_delta" then
        delta = 0
        if args.delta <> invalid then delta = args.delta
        doSeek(delta)
    else if cmd = "pause" then
        m.videoPlayer.control = "pause"
    else if cmd = "resume" then
        m.videoPlayer.control = "resume"
    else if cmd = "stop" then
        m.videoPlayer.control = "stop"
    else if cmd = "play_index" then
        if args.index <> invalid then playIndex(args.index)
    else if cmd = "play_queue" then
        if m.queue.count() > 0 then playIndex(0)
    else if cmd = "refresh_queue" then
        fetchQueue()
        fetchFeatured()
    else if cmd = "change_host" then
        showHostSetup(m.hostUrl)
    end if
end sub

' Event reporting ---------------------------------------------------------
sub onEventTimer()
    if m.videoPlayer.state = "playing" then
        reportEvent("position")
    end if
end sub

sub reportEvent(eventType as string)
    if m.hostUrl = invalid or m.hostUrl = "" then return
    if m.currentIndex < 0 or m.currentIndex >= m.queue.count() then return
    entry = m.queue[m.currentIndex]

    ev = {
        type: eventType,
        index: m.currentIndex,
        url: entry.url,
        title: entry.title,
        position: m.videoPlayer.position,
        duration: m.videoPlayer.duration,
        state: m.videoPlayer.state
    }
    m.eventTask.hostUrl = m.hostUrl
    m.eventTask.authToken = m.authToken
    m.eventTask.event = ev
    m.eventTask.control = "RUN"
end sub

' QR code overlay ---------------------------------------------------------
sub showQrCode()
    if m.hostUrl = "" then
        m.statusLabel.text = "Not connected to a host."
        return
    end if
    ' Build the QR PNG URL — the host serves /qr.png with ?tok= auth
    tok = m.authToken
    if tok = invalid then tok = ""
    qrUrl = m.hostUrl + "/qr.png?tok=" + tok
    m.qrPoster.uri = qrUrl

    ' Show the remote URL for reference
    remoteUrl = m.hostUrl + "/remote#tok=" + tok
    m.qrUrlLabel.text = remoteUrl

    m.qrOverlay.visible = true
end sub

sub hideQrCode()
    m.qrOverlay.visible = false
    m.qrPoster.uri = ""
    m.queueList.setFocus(true)
end sub

' Seek overlay ------------------------------------------------------------
function formatTimeHMS(sec as float) as string
    if sec < 0 then sec = 0
    total = Int(sec)
    hh = total \ 3600
    mm = (total - hh * 3600) \ 60
    ss = total mod 60
    if hh > 0 then
        return hh.toStr() + ":" + right("0" + mm.toStr(), 2) + ":" + right("0" + ss.toStr(), 2)
    end if
    return mm.toStr() + ":" + right("0" + ss.toStr(), 2)
end function

sub showSeekOverlay(delta as integer)
    curPos = m.videoPlayer.position
    dur = m.videoPlayer.duration
    if dur <= 0 then dur = 1

    ' Show what the seek delta was
    if delta > 0 then
        m.seekTitleLabel.text = ">> +" + formatTimeHMS(delta)
    else if delta < 0 then
        m.seekTitleLabel.text = "<< " + formatTimeHMS(delta)
    else
        m.seekTitleLabel.text = ""
    end if

    m.seekTimeLabel.text = formatTimeHMS(curPos) + " / " + formatTimeHMS(dur)

    pct = curPos / dur
    if pct < 0 then pct = 0
    if pct > 1 then pct = 1
    m.seekPctLabel.text = Int(pct * 100).toStr() + "%"
    m.seekBarFill.width = Int(880 * pct)

    m.seekOverlay.visible = true
    m.seekHideTimer.control = "stop"
    m.seekHideTimer.control = "start"
end sub

sub onSeekHideTimer()
    m.seekOverlay.visible = false
end sub

sub doSeek(deltaSec as integer)
    newPos = m.videoPlayer.position + deltaSec
    if newPos < 0 then newPos = 0
    m.videoPlayer.seek = newPos
    showSeekOverlay(deltaSec)
end sub

' Key handling ------------------------------------------------------------
function onKeyEvent(key as string, press as boolean) as boolean
    if not press then return false

    if key = "back" and m.qrOverlay.visible then
        hideQrCode()
        return true
    end if

    if m.videoPlayer.visible then
        if key = "back" then
            m.videoPlayer.control = "stop"
            m.videoPlayer.visible = false
            m.progressGroup.visible = false
            m.seekOverlay.visible = false
            hideAllAnnotations()
            m.statusLabel.text = m.queue.count().toStr() + " videos in queue. Press OK to play."
            m.queueList.setFocus(true)
            reportEvent("state_change")
            return true
        end if
        if key = "right" then
            doSeek(30)
            return true
        end if
        if key = "left" then
            doSeek(-30)
            return true
        end if
        if key = "fastforward" then
            doSeek(60)
            return true
        end if
        if key = "rewind" then
            doSeek(-60)
            return true
        end if
        if key = "play" then
            if m.videoPlayer.state = "paused" then
                m.videoPlayer.control = "resume"
            else
                m.videoPlayer.control = "pause"
            end if
            return true
        end if
    end if
    return false
end function
