# Gson persists these data classes by field name. Keep their serialized shape
# while allowing the rest of the optimized delivery APK to be compiled/shrunk.
-keepattributes Signature,*Annotation*
-keep class com.newmark.mobile.data.** { <fields>; }

# PDFBox JPX and Apache POI diagnostic/rendering integrations are optional on
# Android. Newmark uses PDF text extraction plus Android PdfRenderer, and POI
# text/cell models only; it never enters their desktop AWT/OSGi image paths.
-dontwarn com.gemalto.jp2.JP2Decoder
-dontwarn aQute.bnd.annotation.spi.**
-dontwarn org.osgi.framework.**
-dontwarn java.awt.**
-dontwarn javax.imageio.**
