package com.craftagents.companion;

import java.security.cert.CertificateException;
import java.security.cert.CertPathValidatorException;
import javax.net.ssl.*;
import java.net.*;

/** Sanitized transport categories, never log exception messages or credentials. */
final class TransportError {
    static String describe(Throwable error) {
        boolean handshake=false, ssl=false;
        Throwable t=error;
        for(int depth=0;t!=null&&depth<12;depth++,t=t.getCause()) {
            if(t instanceof CertificateException || t instanceof CertPathValidatorException || t instanceof SSLPeerUnverifiedException)
                return "Certificate identity or trust could not be verified. Check server certificate and device date; verification remains enabled.";
            if(t instanceof SSLHandshakeException)handshake=true;
            if(t instanceof SSLException)ssl=true;
            if(t instanceof UnknownHostException)return "Server name could not be resolved. Check Tailscale and network.";
            if(t instanceof SocketTimeoutException)return "Connection timed out. Check Tailscale and network.";
            if(t instanceof ConnectException || t instanceof NoRouteToHostException)return "Server unreachable. Check Tailscale and network.";
        }
        if(handshake)return "Secure handshake failed; certificate, protocol or network cause is not yet confirmed.";
        if(ssl)return "Secure connection interrupted; this does not by itself prove a certificate failure.";
        return "Server unavailable or connection interrupted.";
    }
}
