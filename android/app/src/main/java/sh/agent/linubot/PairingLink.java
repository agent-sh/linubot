package sh.agent.linubot;
import java.net.URI;
import java.util.Locale;
final class PairingLink {
    final String origin;
    final String url;
    private PairingLink(String origin,String url) { this.origin=origin;this.url=url; }
    static PairingLink parse(String value) {
        try {
            if (value==null || value.length()>2048) throw new IllegalArgumentException();
            URI uri=new URI(value.trim());
            if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost()==null || uri.getRawUserInfo()!=null || uri.getRawQuery()!=null || !"/phone-pair".equals(uri.getRawPath()) || uri.getRawFragment()==null || !uri.getRawFragment().matches("[A-Fa-f0-9]{10}") || uri.getPort()==0 || uri.getPort()>65535 || uri.getPort() < -1) throw new IllegalArgumentException();
            String origin=new URI("https",null,uri.getHost(),uri.getPort(),null,null,null).toString();
            return new PairingLink(origin,origin+"/phone-pair#"+uri.getRawFragment().toUpperCase(Locale.ROOT));
        } catch (Exception error) { throw new IllegalArgumentException("Scan the pairing QR shown in Linubot Settings → Phone access."); }
    }
}
