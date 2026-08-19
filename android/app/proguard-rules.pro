# Gson persists these data classes by field name. Keep their serialized shape
# while allowing the rest of the optimized delivery APK to be compiled/shrunk.
-keepattributes Signature,*Annotation*
-keep class com.newmark.mobile.data.** { <fields>; }
