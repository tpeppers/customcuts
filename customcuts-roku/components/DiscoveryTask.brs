' DiscoveryTask.brs - broadcasts "CC?" on UDP 255.255.255.255:8788 and
' waits up to timeoutMs for a "CC!http://..." reply from the CustomCuts host.
' Writes the extracted URL (or "" on timeout) to the result field, then
' sets done = true.

sub init()
    m.top.functionName = "doDiscover"
end sub

sub doDiscover()
    m.top.done = false
    m.top.result = ""

    sock = CreateObject("roDatagramSocket")
    if sock = invalid then
        m.top.done = true
        return
    end if

    ' Enable broadcast; log but don't bail if this API isn't available
    broadcastOk = sock.setBroadcast(true)
    if broadcastOk = false then
        print "discovery: setBroadcast returned false"
    end if

    ' Bind to any local port so we can receive replies
    localAddr = CreateObject("roSocketAddress")
    localAddr.setHostName("0.0.0.0")
    localAddr.setPort(0)
    sock.bindToAddress(localAddr)

    ' Broadcast query
    dest = CreateObject("roSocketAddress")
    dest.setHostName("255.255.255.255")
    dest.setPort(8788)
    sock.setSendToAddress(dest)

    sent = sock.sendStr("CC?")
    print "discovery: sent CC? ("; sent; " bytes)"

    ' Poll for a reply until timeout
    timeoutMs = m.top.timeoutMs
    if timeoutMs <= 0 then timeoutMs = 3000
    pollStep = 150
    elapsed = 0

    while elapsed < timeoutMs
        if sock.isReadable() then
            reply = sock.receiveStr(1024)
            if reply <> invalid and len(reply) >= 4 then
                if left(reply, 3) = "CC!" then
                    m.top.result = mid(reply, 4)
                    sock.close()
                    m.top.done = true
                    return
                end if
            end if
        end if
        sleep(pollStep)
        elapsed = elapsed + pollStep
    end while

    sock.close()
    m.top.done = true
end sub
