' QueueTask.brs - fetches /queue.json from the CustomCuts streaming host
' and hands back a parsed assocArray over the `result` field.

sub init()
    m.top.functionName = "doFetch"
end sub

sub doFetch()
    url = m.top.hostUrl + "/queue.json"

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

    result = { queue: [], error: "", version: 0 }
    if body = invalid or body = "" then
        result.error = "empty response from " + url
        m.top.result = result
        return
    end if

    parsed = ParseJson(body)
    if parsed = invalid then
        result.error = "could not parse JSON"
        m.top.result = result
        return
    end if
    if parsed.queue = invalid then
        result.error = "response missing 'queue' field"
        m.top.result = result
        return
    end if

    result.queue = parsed.queue
    if parsed.version <> invalid then result.version = parsed.version
    m.top.result = result
end sub
