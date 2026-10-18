import com.google.gson.*;
import com.mojang.serialization.JsonOps;
import net.minecraft.server.packs.metadata.pack.*;
import net.minecraft.server.packs.repository.PackCompatibility;
import net.minecraft.util.InclusiveRange;
public class T {
  public static void main(String[] a) throws Exception {
    net.minecraft.SharedConstants.tryDetectVersion(); net.minecraft.server.Bootstrap.bootStrap();
    var codec = PackMetadataSection.CLIENT_TYPE.codec();
    PackFormat cur = PackFormat.of(Integer.parseInt(a[0]), Integer.parseInt(a[1]));
    for (int i = 2; i < a.length; i++) {
      JsonElement el = JsonParser.parseString(a[i]);
      var r = codec.parse(JsonOps.INSTANCE, el);
      String out;
      if (r.result().isPresent()) {
        var m = r.result().get();
        out = "OK range=" + m.supportedFormats() + " compat=" + PackCompatibility.forVersion(m.supportedFormats(), cur);
      } else out = "ERROR " + r.error().get().message();
      System.out.println(a[i] + "\n   -> " + out);
    }
  }
}
