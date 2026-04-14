' EventTask.brs - POSTs a single event AA to /events on the CustomCuts host.
' HomeScene populates m.top.event and m.top.hostUrl, then sets control = "RUN".

sub init()
    m.top.functionName = "doPost"
end sub

sub doPost()
    host = m.top.hostUrl
    ev = m.top.event
    if host = invalid or host = "" or ev = invalid then
        m.top.sent = false
        return
    end if

    url = host + "/events"
    req = CreateObject("roUrlTransfer")
    req.setUrl(url)
    req.setCertificatesFile("common:/certs/ca-bundle.crt")
    req.initClientCertificates()
    req.retainBodyOnError(true)
    req.addHeader("Content-Type", "application/json")

    body = FormatJson(ev)
    code = req.postFromString(body)
    m.top.sent = (code = 200)
end sub
