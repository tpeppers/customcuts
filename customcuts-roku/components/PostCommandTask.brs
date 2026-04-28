' PostCommandTask.brs - fire-and-forget POST /commands from the Roku UI.
' HomeScene uses this to send load_featured after the user picks a poster
' from the featured rows. Runs on a task thread so the UI doesn't block
' on the HTTP round-trip.

sub init()
    m.top.functionName = "doPost"
end sub

sub doPost()
    url = m.top.hostUrl + "/commands"
    bodyStr = "{""cmd"":""" + m.top.cmdName + """,""args"":" + m.top.argsJson + "}"

    req = CreateObject("roUrlTransfer")
    req.setUrl(url)
    req.setCertificatesFile("common:/certs/ca-bundle.crt")
    req.initClientCertificates()
    req.retainBodyOnError(true)
    req.addHeader("Accept", "application/json")
    req.addHeader("Content-Type", "application/json")
    if m.top.authToken <> invalid and m.top.authToken <> "" then
        req.addHeader("X-CC-Auth", m.top.authToken)
    end if

    resp = req.postFromString(bodyStr)
    result = { ok: true, status: resp }
    m.top.result = result
end sub
