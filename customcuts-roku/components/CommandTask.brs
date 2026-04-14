' CommandTask.brs - polls /commands?since=<seq> on the CustomCuts host.
' Each RUN performs exactly one fetch; a Timer node in HomeScene drives
' the polling cadence (default ~1s).

sub init()
    m.top.functionName = "doFetch"
end sub

sub doFetch()
    host = m.top.hostUrl
    if host = invalid or host = "" then
        m.top.result = { commands: [], next_seq: m.top.sinceSeq, error: "no host" }
        return
    end if

    url = host + "/commands?since=" + m.top.sinceSeq.toStr()

    req = CreateObject("roUrlTransfer")
    req.setUrl(url)
    req.setCertificatesFile("common:/certs/ca-bundle.crt")
    req.initClientCertificates()
    req.retainBodyOnError(true)
    req.addHeader("Accept", "application/json")
    if m.top.authToken <> invalid and m.top.authToken <> "" then
        req.addHeader("X-CC-Auth", m.top.authToken)
    end if

    body = req.getToString()

    result = { commands: [], next_seq: m.top.sinceSeq, error: "" }
    if body = invalid or body = "" then
        result.error = "empty response"
        m.top.result = result
        return
    end if

    parsed = ParseJson(body)
    if parsed = invalid then
        result.error = "parse error"
        m.top.result = result
        return
    end if

    if parsed.commands <> invalid then result.commands = parsed.commands
    if parsed.next_seq <> invalid then result.next_seq = parsed.next_seq
    m.top.result = result
end sub
