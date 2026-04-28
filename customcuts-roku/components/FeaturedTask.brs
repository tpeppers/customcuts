' FeaturedTask.brs - fetches /featured.json from the CustomCuts host
' and hands back {classics: [...], incoming: [...]} via the result field.
' Each entry includes {url, title, thumb_path, thumb_url, thumb_exists}.

sub init()
    m.top.functionName = "doFetch"
end sub

sub doFetch()
    url = m.top.hostUrl + "/featured.json"

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

    result = { classics: [], incoming: [], error: "", version: 0 }
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

    if parsed.classics <> invalid then result.classics = parsed.classics
    if parsed.incoming <> invalid then result.incoming = parsed.incoming
    if parsed.version <> invalid then result.version = parsed.version
    m.top.result = result
end sub
