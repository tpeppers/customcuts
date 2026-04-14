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
    m.videoPlayer = m.top.findNode("videoPlayer")
    m.queueTask = m.top.findNode("queueTask")
    m.cmdTask = m.top.findNode("cmdTask")
    m.eventTask = m.top.findNode("eventTask")
    m.discoveryTask = m.top.findNode("discoveryTask")
    m.cmdTimer = m.top.findNode("cmdTimer")
    m.eventTimer = m.top.findNode("eventTimer")

    m.queue = []
    m.currentIndex = -1
    m.cutsState = invalid
    m.commandSeq = 0
    m.hostDialog = invalid
    m.lastReportedState = ""
    m.hostUrl = ""

    m.queueList.observeField("itemSelected", "onQueueItemSelected")
    m.videoPlayer.observeField("state", "onVideoState")
    m.videoPlayer.observeField("position", "onVideoPosition")
    m.queueTask.observeField("result", "onQueueFetched")
    m.cmdTask.observeField("result", "onCommandsFetched")
    m.discoveryTask.observeField("done", "onDiscoveryDone")
    m.cmdTimer.observeField("fire", "onCmdTimer")
    m.eventTimer.observeField("fire", "onEventTimer")

    m.top.setFocus(true)

    m.hostUrl = loadHostUrl()
    if m.hostUrl = "" then
        runDiscovery()
    else
        m.statusLabel.text = "Host: " + m.hostUrl
        startPollers()
        fetchQueue()
    end if
end sub

' LAN discovery -----------------------------------------------------------
sub runDiscovery()
    m.statusLabel.text = "Searching for CustomCuts host on LAN..."
    m.discoveryTask.timeoutMs = 3000
    m.discoveryTask.control = "RUN"
end sub

sub onDiscoveryDone()
    if not m.discoveryTask.done then return
    found = m.discoveryTask.result
    if found <> invalid and found <> "" then
        saveHostUrl(found)
        m.hostUrl = found
        m.statusLabel.text = "Host discovered: " + found
        startPollers()
        fetchQueue()
    else
        m.statusLabel.text = "No host found. Enter address manually."
        showHostSetup("192.168.1.100:8787")
    end if
end sub

' Host URL persistence ----------------------------------------------------
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

sub showHostSetup(initialText as string)
    kbd = CreateObject("roSGNode", "KeyboardDialog")
    kbd.title = "CustomCuts Host"
    kbd.message = "Enter host address (IP:PORT, e.g. 192.168.1.42:8787)"
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
        url = normalizeHostUrl(raw)
        saveHostUrl(url)
        m.hostUrl = url
        m.top.dialog = invalid
        m.hostDialog = invalid
        m.statusLabel.text = "Host saved: " + url
        startPollers()
        fetchQueue()
    else
        m.top.dialog = invalid
        m.hostDialog = invalid
        m.statusLabel.text = "Setup cancelled. Relaunch to retry."
    end if
end sub

function normalizeHostUrl(raw as string) as string
    s = raw
    while len(s) > 0 and (right(s, 1) = " " or right(s, 1) = chr(9))
        s = left(s, len(s) - 1)
    end while
    while len(s) > 0 and (left(s, 1) = " " or left(s, 1) = chr(9))
        s = mid(s, 2)
    end while
    if lCase(left(s, 7)) = "http://" then return s
    if lCase(left(s, 8)) = "https://" then return s
    return "http://" + s
end function

' Queue fetching + list ---------------------------------------------------
sub startPollers()
    m.cmdTimer.control = "start"
    m.eventTimer.control = "start"
end sub

sub fetchQueue()
    m.statusLabel.text = "Fetching queue from " + m.hostUrl + "..."
    m.queueTask.hostUrl = m.hostUrl
    m.queueTask.control = "RUN"
end sub

sub onQueueFetched()
    result = m.queueTask.result
    if result = invalid then
        m.statusLabel.text = "Fetch failed: no response."
        return
    end if
    if result.error <> invalid and result.error <> "" then
        m.statusLabel.text = "Fetch failed: " + result.error
        return
    end if
    if result.queue = invalid then
        m.statusLabel.text = "Fetch failed: missing queue field in response."
        return
    end if

    m.queue = result.queue

    ' Build the LabelList content: a [Change Host] row at index 0, then
    ' the actual queue. playIndex() still takes a queue-relative index, so
    ' onQueueItemSelected subtracts 1.
    items = CreateObject("roSGNode", "ContentNode")
    changeHostItem = items.createChild("ContentNode")
    changeHostItem.title = "[Change Host]"
    for i = 0 to m.queue.count() - 1
        entry = m.queue[i]
        item = items.createChild("ContentNode")
        item.title = entry.title
    end for
    m.queueList.content = items
    m.queueList.visible = true
    m.queueList.setFocus(true)

    if m.queue.count() = 0 then
        m.statusLabel.text = "Queue is empty. Play a playlist in the extension."
    else
        m.statusLabel.text = m.queue.count().toStr() + " videos in queue. Press OK to play."
    end if
end sub

sub onQueueItemSelected()
    idx = m.queueList.itemSelected
    if idx = 0 then
        showHostSetup(m.hostUrl)
        return
    end if
    playIndex(idx - 1)
end sub

sub playIndex(idx as integer)
    if idx < 0 or idx >= m.queue.count() then return
    m.currentIndex = idx
    entry = m.queue[idx]

    m.cutsState = buildCutsState(entry)

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
    reportEvent("playback_started")
end sub

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

' Video playback observers ------------------------------------------------
sub onVideoPosition()
    if m.cutsState = invalid then return
    pos = m.videoPlayer.position

    if m.cutsState.queueEndTime > 0 and not m.cutsState.queueEndTriggered then
        if pos >= m.cutsState.queueEndTime then
            m.cutsState.queueEndTriggered = true
            advanceQueue()
            return
        end if
    end if

    mode = m.cutsState.mode

    if mode = "skip" then
        for each r in m.cutsState.skip
            if pos >= r.start and pos < r.end then
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
            if pos >= r.start and pos < r.end then
                inRange = true
                exit for
            end if
            if r.start > pos then
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
            if pos >= r.start and pos < r.end then
                inRange = true
                exit for
            end if
            if r.start > pos then
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
    m.cmdTask.sinceSeq = m.commandSeq
    m.cmdTask.control = "RUN"
end sub

sub onCommandsFetched()
    result = m.cmdTask.result
    if result = invalid then return
    if result.error <> invalid and result.error <> "" then return
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
        if args.position <> invalid then m.videoPlayer.seek = args.position
    else if cmd = "seek_delta" then
        delta = 0
        if args.delta <> invalid then delta = args.delta
        newPos = m.videoPlayer.position + delta
        if newPos < 0 then newPos = 0
        m.videoPlayer.seek = newPos
    else if cmd = "pause" then
        m.videoPlayer.control = "pause"
    else if cmd = "resume" then
        m.videoPlayer.control = "resume"
    else if cmd = "stop" then
        m.videoPlayer.control = "stop"
    else if cmd = "play_index" then
        if args.index <> invalid then playIndex(args.index)
    else if cmd = "refresh_queue" then
        fetchQueue()
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
    m.eventTask.event = ev
    m.eventTask.control = "RUN"
end sub
