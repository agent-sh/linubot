package sh.agent.linubot;
import org.junit.Test;
import static org.junit.Assert.*;
import com.google.zxing.*;
import com.google.zxing.common.*;
public class PairingLinkTest {
 @Test public void decodesTheExistingPairingQr() throws Exception {
  String value="https://computer.tailnet.ts.net:45874/phone-pair#A1B2C3D4E5";
  BitMatrix matrix=new MultiFormatWriter().encode(value,BarcodeFormat.QR_CODE,320,320);
  int[] pixels=new int[320*320];for(int y=0;y<320;y++)for(int x=0;x<320;x++)pixels[y*320+x]=matrix.get(x,y)?0xff000000:0xffffffff;
  String decoded=new MultiFormatReader().decode(new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(320,320,pixels)))).getText();
  PairingLink link=PairingLink.parse(decoded);assertEquals("https://computer.tailnet.ts.net:45874",link.origin);assertEquals(value,link.url);
 }
 @Test public void rejectsUnrelatedOrUnsafeCodes() {
  for(String value:new String[]{"http://computer/phone-pair#A1B2C3D4E5","https://user:secret@computer/phone-pair#A1B2C3D4E5","https://computer/wrong#A1B2C3D4E5","https://computer/phone-pair?redirect=elsewhere#A1B2C3D4E5","javascript:alert(1)","https://computer/phone-pair#invalid"}) {
   try {PairingLink.parse(value);fail(value);} catch(IllegalArgumentException expected) {}
  }
 }
}
