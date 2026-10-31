package com.craftagents.companion;
import org.json.*;
import javax.net.ssl.*;
import java.security.cert.CertificateException;
public final class ChatModelTest {
 static int checks; static void check(boolean b){checks++;if(!b)throw new AssertionError("check "+checks);}
 static JSONObject session(String id,String...labels)throws Exception{return new JSONObject().put("id",id).put("labels",new JSONArray(labels));}
 public static void main(String[] args)throws Exception {
  check(ChatModel.group(session("x","puck-subagent")).equals("Subagents"));
  check(ChatModel.group(session("x","puck-automation")).equals("Automations"));
  check(ChatModel.group(session("x","puckish")).equals("Other chats"));
  check(ChatModel.group(session("x","puck-automation-extra")).equals("Other chats"));
  check(ChatModel.primary(session("261022-fresh-gust","puck")));
  check(!ChatModel.primary(session("261022-fresh-gust","puck-subagent")));
  check(!ChatModel.primary(session("x","puck")));
  check(TransportError.describe(new SSLException("closed")).contains("does not by itself prove"));
  check(TransportError.describe(new SSLHandshakeException("protocol")).contains("not yet confirmed"));
  check(TransportError.describe(new SSLHandshakeException("trust"){ {initCause(new CertificateException());} }).startsWith("Certificate"));
  check(TransportError.describe(new java.net.UnknownHostException()).contains("Tailscale"));
  JSONArray input=new JSONArray(); String payload=String.join("",java.util.Collections.nCopies(16000,"x"));
  for(int i=0;i<100;i++)input.put(new JSONObject().put("id","m"+i).put("role",i%2==0?"user":"assistant").put("content",payload).put("timestamp",i));
  ChatModel model=new ChatModel();check(model.update(input));check(model.changedRows==100);Object original=model.rows.get(0);
  long start=System.nanoTime();for(int i=0;i<1000;i++)check(!model.update(input));long elapsed=System.nanoTime()-start;
  check(model.rows.get(0)==original);check(model.changedRows==0);
  input.getJSONObject(99).put("content","new final reply");check(model.update(input));check(model.changedRows==1);check(model.rows.get(0)==original);
  input.put(new JSONObject().put("id","m100").put("role","user").put("content","hello"));check(model.update(input));check(model.changedRows==1);
  Object second=model.rows.get(1);long secondId=model.rows.get(1).stableId;
  input.remove(0);check(model.update(input));check(model.changedRows==0);check(model.rows.get(0)==second);check(model.rows.get(0).stableId==secondId);
  JSONArray prepended=new JSONArray().put(new JSONObject().put("id","older").put("content","earlier"));for(int i=0;i<input.length();i++)prepended.put(input.get(i));
  check(model.update(prepended));check(model.changedRows==1);check(model.rows.get(1)==second);
  JSONArray reordered=new JSONArray();for(int i=prepended.length()-1;i>=0;i--)reordered.put(prepended.get(i));check(model.update(reordered));check(model.changedRows==0);check(model.rows.get(model.rows.size()-2)==second);
  JSONArray duplicates=new JSONArray().put(new JSONObject().put("id","duplicate").put("content","a")).put(new JSONObject().put("id","duplicate").put("content","b"));check(model.update(duplicates));check(model.rows.get(0).stableId!=model.rows.get(1).stableId);check(!model.update(duplicates));
  System.out.println("PASS "+checks+" chat/error assertions; fixture100x16000chars; unchanged1000 total_ms="+(elapsed/1e6)+" avg_ms="+(elapsed/1e6/1000)+"; unchanged row objects retained; one changed row=1");
 }
}
