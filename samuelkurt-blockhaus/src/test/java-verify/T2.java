import java.nio.file.*;
import java.util.Optional;
import net.minecraft.network.chat.Component;
import net.minecraft.server.packs.*;
import net.minecraft.server.packs.metadata.pack.PackFormat;
import net.minecraft.server.packs.repository.*;
public class T2 {
  public static void main(String[] a) throws Exception {
    net.minecraft.SharedConstants.tryDetectVersion(); net.minecraft.server.Bootstrap.bootStrap();
    PackFormat cur = net.minecraft.SharedConstants.getCurrentVersion().packVersion(PackType.CLIENT_RESOURCES);
    System.out.println("CURRENT pack format = " + cur);
    for (String f : a) {
      PackLocationInfo loc = new PackLocationInfo("server/test", Component.literal("t"), PackSource.SERVER, Optional.empty());
      Pack.ResourcesSupplier sup = new FilePackResources.FileResourcesSupplier(Path.of(f));
      Pack.Metadata m = Pack.readPackMetadata(loc, sup, cur, PackType.CLIENT_RESOURCES);
      System.out.println(Path.of(f).getFileName() + " -> " + (m == null ? "IGNORED (invalid pack metadata)" : "LOADED, compatibility=" + m.compatibility() + ", description=" + m.description().getString()));
    }
  }
}
