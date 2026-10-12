# fetch-win-native.ps1 — baut resources-native/ für das native Windows-Backend
# (Server-App OHNE WSL2/Virtualisierung). Lokales Gegenstück zum CI-Step
# "native Backend-Bausteine bündeln" (win-build-server.yml).
#
# Layout nach Lauf:
#   resources-native/
#     native-bin/   caddy.exe, weed.exe, livekit-server.exe, mediamtx.exe,
#                   direct-adapter.exe, frpc.exe, garnet/GarnetServer.exe
#                   (+dlls), dotnet/ (Runtime für Garnet), pg/bin/ (Postgres 15)
#     python/       venv (uv, Python 3.13) mit allen Service-Deps
#     services/     Python-Quellen: auth, chat-gateway, media-svc,
#                   voice-signaling, mediamtx-auth-hook, shared
#     templates/    Caddyfile.template (aus infra/self-host)
#     gen_selfsigned_cert.py
#
# weed.exe: SeaweedFS liefert KEIN volles Windows-Binary mehr (nur weed-volume,
# ohne Subcommands, 2026-10 verifiziert) → aus dem Source gebaut (Go cross-
# compile, CI) oder lokal via -WeedSource. direct-adapter.exe: cargo build
# aus infra/self-host/direct-adapter (CI) oder lokal via -AdapterSource.

param(
    [string]$Root = (Join-Path $PSScriptRoot "..\resources-native"),
    [switch]$WeedSource,   # weed.exe selbst bauen (braucht go + Netz)
    [switch]$AdapterSource # direct-adapter.exe selbst bauen (braucht cargo)
)

$ErrorActionPreference = "Stop"

# Versions-Pins — zusammen mit den SHA256-Prüfungen pflegen. JEDER Download
# unten läuft über Fetch und wird gegen die Prüfsumme hier verglichen; eine
# Abweichung bricht den Bau ab, bevor irgendetwas entpackt wird. Wer eine
# Version anhebt, trägt die neue Prüfsumme in derselben Zeile nach — Fetch
# lässt sich ohne Prüfsumme gar nicht aufrufen.
#
# Woher die Werte stammen (Stand 2026-10-12, je Datei mit curl geladen und mit
# sha256sum nachgerechnet):
#   Caddy, frp, LiveKit, MediaMTX, .NET: gegen die Liste des Herstellers
#     geprüft (Caddy `caddy_<v>_checksums.txt` und .NET `releases.json` führen
#     SHA512 — die SHA256 hier ist selbst berechnet, die Datei zuvor gegen die
#     SHA512 des Herstellers bestätigt; frp, LiveKit und MediaMTX führen SHA256
#     und stimmen wörtlich überein).
#   Garnet: keine Herstellerliste; selbst berechnet und gegen die von GitHub am
#     Release-Asset angezeigte `sha256:`-Angabe bestätigt.
#   Postgres (EDB): keine Herstellerliste; selbst berechnet (der MD5 aus den
#     S3-Metadaten des Servers stimmte mit der Datei überein).
#   weed (SeaweedFS): kein Download, sondern `git clone` am Tag — festgeschrieben
#     ist der Commit, auf den der Tag zeigt.
$CaddyVersion   = "2.8.4"
$CaddySha256    = "2631fbe1c4f6fb08783ed6dc6ac238d6655b4c923abe2bce1433dbd7fd079630"
$GarnetVersion  = "2.2.0"
$GarnetSha256   = "8812ae916dd2386db6ebfaeeee3fb6508024f82ee4c66284532a1a5baa6afea2"
$LivekitVersion = "1.13.3"   # gleiches Pin wie das allinone-Image
$LivekitSha256  = "d29786e63a11de390fb8051191a30520cfb687d8f6cb5063b6ef0f748f029727"
$MediamtxVersion = "1.19.1"  # upstream; Fork-Windows-Artifact steht noch aus
$MediamtxSha256 = "ca3d89c370bf73dc33ef9ee87afea04834f21b129f499d4b645490fcb01cce22"
$PgVersion      = "15.14-1"
$PgSha256       = "234ccc7a5cf07fce70f93faea701fd75fad6bec968359b06cdfc208ed7dfbc30"
$DotnetVersion  = "10.0.12"
$DotnetSha256   = "da3947e6acbb5228e4e987c7585aa40ce2d7000856e3da0804e6ee3771e806dc"
$WeedVersion    = "4.48"
$WeedCommit     = "530be3e37337488ecc34d58441e0bc476e121c93"   # Commit, auf den der Tag 4.48 zeigt
$FrpVersion     = "0.69.1"   # passend zum frps der Cloud (snowdreamtech/frps:0.69.1)
$FrpSha256      = "829ac915f8655d4d4e021b8db61b46c3445205ed80d32b04cda7fa89d87c46e0"

$Repo = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$Tmp = Join-Path $env:TEMP "pulse-native-fetch"
New-Item -ItemType Directory -Force -Path $Tmp, $Root | Out-Null
$Bin = Join-Path $Root "native-bin"
New-Item -ItemType Directory -Force -Path $Bin | Out-Null

# Lädt $Url nach $Out und bricht ab, wenn die SHA256-Prüfsumme nicht stimmt.
# Die Prüfsumme ist Pflicht (kein Standardwert): ein Download ohne sie wäre
# genau die Lücke, die dieser Aufruf schließt. Die Datei bleibt bei einem
# Fehlschlag nicht liegen, damit ein späterer Lauf sie nicht für gut hält.
function Fetch($Url, $Out, $Sha256) {
    if ($Sha256 -notmatch '^[0-9a-fA-F]{64}$') {
        throw "Fetch: keine gültige SHA256-Prüfsumme für $Url angegeben"
    }
    Write-Host "→ $Url"
    Invoke-WebRequest -Uri $Url -OutFile $Out -MaximumRedirection 5
    $actual = (Get-FileHash -Path $Out -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $Sha256.ToLowerInvariant()) {
        Remove-Item -Path $Out -Force -ErrorAction SilentlyContinue
        throw "SHA256 stimmt nicht für $Url`n  erwartet: $($Sha256.ToLowerInvariant())`n  erhalten: $actual`n  Quelle verändert oder Version angehoben, ohne die Prüfsumme oben nachzutragen — Download wurde verworfen."
    }
    Write-Host "  SHA256 ok"
}

function Unzip($Zip, $Dest) {
    Expand-Archive -Path $Zip -DestinationPath $Dest -Force
}

# ── Caddy ────────────────────────────────────────────────────────────────────
if (-not (Test-Path (Join-Path $Bin "caddy.exe"))) {
    Fetch "https://github.com/caddyserver/caddy/releases/download/v$CaddyVersion/caddy_${CaddyVersion}_windows_amd64.zip" "$Tmp/caddy.zip" $CaddySha256
    Unzip "$Tmp/caddy.zip" "$Tmp/caddy"
    Copy-Item "$Tmp/caddy/caddy.exe" $Bin
}

# ── frpc (Steuerungs-Relay-Tunnel: /livekit + /whep auf den Relay-Hostnamen) ─
if (-not (Test-Path (Join-Path $Bin "frpc.exe"))) {
    Fetch "https://github.com/fatedier/frp/releases/download/v$FrpVersion/frp_${FrpVersion}_windows_amd64.zip" "$Tmp/frp.zip" $FrpSha256
    Unzip "$Tmp/frp.zip" "$Tmp/frp"
    Copy-Item "$Tmp/frp/frp_${FrpVersion}_windows_amd64/frpc.exe" $Bin
}

# ── Garnet (+ .NET-Runtime — das Release-Zip ist runtime-abhängig) ──────────
if (-not (Test-Path (Join-Path $Bin "garnet\GarnetServer.exe"))) {
    Fetch "https://github.com/microsoft/garnet/releases/download/v$GarnetVersion/win-x64-based-readytorun.zip" "$Tmp/garnet.zip" $GarnetSha256
    Unzip "$Tmp/garnet.zip" "$Tmp/garnet"
    $garnetExe = Get-ChildItem "$Tmp/garnet" -Recurse -Filter "GarnetServer.exe" | Select-Object -First 1
    if (-not $garnetExe) { throw "GarnetServer.exe nicht im Release-Zip" }
    New-Item -ItemType Directory -Force -Path (Join-Path $Bin "garnet") | Out-Null
    Copy-Item (Join-Path $garnetExe.Directory.FullName "*") (Join-Path $Bin "garnet") -Recurse -Force
}
if (-not (Test-Path (Join-Path $Bin "dotnet\dotnet.exe"))) {
    Fetch "https://builds.dotnet.microsoft.com/dotnet/Runtime/$DotnetVersion/dotnet-runtime-$DotnetVersion-win-x64.zip" "$Tmp/dotnet.zip" $DotnetSha256
    Unzip "$Tmp/dotnet.zip" (Join-Path $Bin "dotnet")
}

# ── LiveKit ─────────────────────────────────────────────────────────────────
if (-not (Test-Path (Join-Path $Bin "livekit-server.exe"))) {
    Fetch "https://github.com/livekit/livekit-server/releases/download/v$LivekitVersion/livekit_${LivekitVersion}_windows_amd64.zip" "$Tmp/livekit.zip" $LivekitSha256
    Unzip "$Tmp/livekit.zip" "$Tmp/livekit"
    Copy-Item "$Tmp/livekit/livekit-server.exe" $Bin
}

# ── MediaMTX ────────────────────────────────────────────────────────────────
if (-not (Test-Path (Join-Path $Bin "mediamtx.exe"))) {
    Fetch "https://github.com/bluenviron/mediamtx/releases/download/v$MediamtxVersion/mediamtx_v${MediamtxVersion}_windows_amd64.zip" "$Tmp/mediamtx.zip" $MediamtxSha256
    Unzip "$Tmp/mediamtx.zip" "$Tmp/mediamtx"
    Copy-Item "$Tmp/mediamtx/mediamtx.exe" $Bin
}

# ── weed (SeaweedFS) — self-built bis ein volles Windows-Release existiert ──
if (-not (Test-Path (Join-Path $Bin "weed.exe"))) {
    if ($WeedSource) {
        if (-not (Get-Command go -ErrorAction SilentlyContinue)) { throw "go nicht gefunden (-WeedSource)" }
        $src = Join-Path $Tmp "seaweedfs"
        if (-not (Test-Path $src)) {
            git clone --depth 1 --branch "$WeedVersion" https://github.com/seaweedfs/seaweedfs.git $src
            if ($LASTEXITCODE -ne 0) { throw "git clone seaweedfs fehlgeschlagen (Exit $LASTEXITCODE)" }
        }
        # Ein Tag lässt sich umhängen, ein Commit nicht: gebaut wird nur, wenn
        # der Tag noch auf den festgeschriebenen Commit zeigt. Die Prüfung steht
        # außerhalb des Klon-Zweigs, weil ein Ordner aus einem früheren Lauf
        # (lokal, nicht im frischen CI-Runner) genauso stimmen muss.
        $weedHead = (git -C $src rev-parse HEAD)
        if ($LASTEXITCODE -ne 0) { throw "git rev-parse im SeaweedFS-Klon fehlgeschlagen (Exit $LASTEXITCODE)" }
        $weedHead = "$weedHead".Trim()
        if ($weedHead -ne $WeedCommit) {
            throw "SeaweedFS $WeedVersion zeigt nicht auf den festgeschriebenen Commit`n  erwartet: $WeedCommit`n  erhalten: $weedHead`n  Tag umgehängt oder Version angehoben, ohne `$WeedCommit nachzutragen — nichts gebaut."
        }
        Push-Location (Join-Path $src "weed")
        # CGO aus: cgofuse (weed mount) verlangt sonst WinFsp-C-Header, die
        # weder der Runner noch ein normaler Rechner hat — der Pulse-Stack
        # nutzt mount NICHT (master/volume/filer/s3 sind reines Go; cgofuse
        # hat einen !cgo-Fallback). Der CI-Lauf vom 2026-10-03 scheiterte
        # genau daran (fuse_common.h nicht gefunden) und wurde vom
        # fehlenden weed-Check maskiert.
        $env:CGO_ENABLED = "0"
        go build -trimpath -ldflags "-s -w" -o (Join-Path $Bin "weed.exe") .
        $goExit = $LASTEXITCODE
        Remove-Item Env:CGO_ENABLED -ErrorAction SilentlyContinue
        Pop-Location
        # Native Befehle werfen in PS nicht — ohne diesen Check lief der CI-Build
        # (2026-10-03) komplett durch, aber OHNE weed.exe (go-Fehler maskiert).
        if ($goExit -ne 0 -or -not (Test-Path (Join-Path $Bin "weed.exe"))) {
            throw "go build weed.exe fehlgeschlagen (Exit $goExit) — Log oben"
        }
    } else {
        throw "weed.exe fehlt — CI-Artifact oder -WeedSource verwenden (kein offizielles Windows-Release, siehe Kopf)."
    }
}

# ── direct-adapter ──────────────────────────────────────────────────────────
if (-not (Test-Path (Join-Path $Bin "direct-adapter.exe"))) {
    if ($AdapterSource) {
        if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) { throw "cargo nicht gefunden (-AdapterSource)" }
        Push-Location (Join-Path $Repo "infra\self-host\direct-adapter")
        cargo build --release
        Copy-Item "target\release\direct-adapter.exe" $Bin
        Pop-Location
    } else {
        Write-Warning "direct-adapter.exe fehlt — Direktpfad/Chat-Brücke bleibt aus (CI-Artifact oder -AdapterSource)."
    }
}

# ── Postgres 15 (EDB portable binaries) ─────────────────────────────────────
# initdb braucht bin/ + lib/ + share/ (postgres.bki, Timezonedaten) — der
# Rest des EDB-Zips (pgAdmin, doc, include, StackBuilder) bleibt draußen.
if (-not (Test-Path (Join-Path $Bin "pg\share\postgres.bki"))) {
    Fetch "https://get.enterprisedb.com/postgresql/postgresql-$PgVersion-windows-x64-binaries.zip" "$Tmp/pg.zip" $PgSha256
    Unzip "$Tmp/pg.zip" "$Tmp/pg"
    $pgBinSrc = Get-ChildItem "$Tmp/pg" -Recurse -Filter "postgres.exe" | Select-Object -First 1
    if (-not $pgBinSrc) { throw "postgres.exe nicht im EDB-Zip" }
    $pgSrc = $pgBinSrc.Directory.Parent.FullName
    New-Item -ItemType Directory -Force -Path (Join-Path $Bin "pg") | Out-Null
    foreach ($part in @("bin", "lib", "share")) {
        Copy-Item (Join-Path $pgSrc $part) (Join-Path $Bin "pg") -Recurse -Force
    }
}

# ── Python-venv (uv) mit allen Service-Deps ────────────────────────────────
$venv = Join-Path $Root "python"
if (-not (Test-Path (Join-Path $venv "python.exe"))) {
    if (-not (Get-Command uv -ErrorAction SilentlyContinue)) { throw "uv nicht gefunden — https://docs.astral.sh/uv/" }
    uv venv $venv --python 3.13
    # Deps aus den pyprojects (die Quelle der Wahrheit), NICHT von Hand:
    foreach ($svc in @("auth", "chat-gateway", "media-svc", "voice-signaling", "mediamtx-auth-hook")) {
        uv pip install --python $venv (Join-Path $Repo "services\$svc")
    }
    uv pip install --python $venv (Join-Path $Repo "shared")
}

# ── Service-Quellen + Templates + Cert-Helfer ──────────────────────────────
$svcDest = Join-Path $Root "services"
New-Item -ItemType Directory -Force -Path $svcDest | Out-Null
foreach ($d in @("auth", "chat-gateway", "media-svc", "voice-signaling", "mediamtx-auth-hook")) {
    $from = Join-Path $Repo "services\$d"
    $to = Join-Path $svcDest $d
    if (Test-Path $to) { Remove-Item $to -Recurse -Force }
    robocopy $from $to /E /XD __pycache__ .venv tests /NFL /NDL /NJH /NJS | Out-Null
    # robocopy: 0-7 sind Erfolgscodes (1 = Dateien kopiert), ab 8 Fehler.
    if ($LASTEXITCODE -ge 8) { throw "robocopy $d fehlgeschlagen (Exit $LASTEXITCODE)" }
}
$sharedTo = Join-Path $svcDest "shared"
if (Test-Path $sharedTo) { Remove-Item $sharedTo -Recurse -Force }
robocopy (Join-Path $Repo "shared") $sharedTo /E /XD __pycache__ .venv tests /NFL /NDL /NJH /NJS | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy shared fehlgeschlagen (Exit $LASTEXITCODE)" }

$tplDest = Join-Path $Root "templates"
New-Item -ItemType Directory -Force -Path $tplDest | Out-Null
Copy-Item (Join-Path $Repo "infra\self-host\s6\etc\caddy\Caddyfile.template") $tplDest -Force
Copy-Item (Join-Path $Repo "desktop\electron\gen_selfsigned_cert.py") $Root -Force

Write-Host "`nresources-native fertig: $Root"

# Pflicht-Binaries: fehlt auch nur eine, ist der Installer unbrauchbar —
# lieber hier hart scheitern als Stillstand beim Nutzer (0.1.93-Lektion:
# still fehlendes weed.exe fiel erst im Feld auf).
foreach ($required in @("caddy.exe", "frpc.exe", "livekit-server.exe", "mediamtx.exe", "weed.exe", "direct-adapter.exe", "garnet\GarnetServer.exe", "dotnet\dotnet.exe", "pg\bin\postgres.exe")) {
    if (-not (Test-Path (Join-Path $Bin $required))) {
        throw "Pflicht-Binary fehlt: $required"
    }
}
if (-not (Test-Path (Join-Path $venv "Scripts\python.exe"))) { throw "venv-Python fehlt" }

# pwsh -File gibt sonst den Exit-Code des LETZTEN nativen Befehls zurück —
# robocopy meldet 1 bei Erfolg ("Dateien kopiert"), der CI-Schritt failte
# trotz vollständigem Lauf (Win-Runner, 2026-10-03). Explizit 0 setzen.
exit 0
