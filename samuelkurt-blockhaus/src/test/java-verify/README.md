# Check texture-pack logic against the real Minecraft code

Optional, needs Java 25 and a Minecraft 26.x server jar. Nothing here runs in the app or in `node --test`.

```bash
# 1. unpack the libraries and server classes from the server jar (a "bundler" jar)
mkdir mc && cd mc && unzip -q ../server.jar 'META-INF/libraries/*' 'META-INF/versions/*' && cd ..
export JAVA25=/path/to/jdk-25/bin/java
export MC_CLASSPATH="java-verify:mc/META-INF/versions/26.3/server-26.3.jar:$(find mc/META-INF/libraries -name '*.jar' | tr '\n' ':')"
javac -cp "$MC_CLASSPATH" -d java-verify java-verify/T.java java-verify/T2.java

# 2. what would the Minecraft client do with these ZIPs? (same call as the client's server-pack loader)
$JAVA25 -cp "$MC_CLASSPATH" T2 some-pack.zip other-pack.zip      # "LOADED" or "IGNORED (invalid pack metadata)"

# 3. does lib/packs.js metaProblems() agree with the real parser on random pack.mcmeta sections?
node java-verify/compare-metaProblems.js
```
Result when this was written (Minecraft 26.3, 12,600 random cases): no differences.
