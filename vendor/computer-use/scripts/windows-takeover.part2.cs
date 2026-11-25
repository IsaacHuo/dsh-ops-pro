  // Independent progress window: never activates, captures input or arms Esc.
  // Per-pixel composition: the background can be translucent without fading text.
  // One physical-resolution surface also avoids opaque system scrollbars and DPI stretching.
  internal sealed class ProgressFrame : Form {
    sealed class ReadingLine { internal string text; internal bool heading; internal ReadingLine(string s,bool h){text=s;heading=h;} }
    readonly List<ReadingLine> lines=new List<ReadingLine>();
    internal string Content="";
    internal bool Locked=true;
    internal double BackgroundOpacity=.6;
    Font bodyFont,headingFont,titleFont,footerFont;
    string header="",subheader="",bodyText="";
    string[] headings=new string[0];
    bool followOutput=true,remoteVisible=true,configuredLocked=true,configured,presenting,draggingThumb,revealedResult,previewUnlocked,hoverUnlocked,hoverBlocked=true,sizing;
    // Resting the pointer on the lock button this long unlocks the window; it
    // locks again once the pointer has been away from the window this long.
    internal const int HoverUnlockMs=400,HoverRelockMs=1500;
    DateTime hoverSince=DateTime.MinValue,awaySince=DateTime.MinValue;
    float hoverFraction;
    // Sizes and positions this window reported itself, with when, so that their
    // echo from the settings never moves the window back (see Configure).
    readonly List<KeyValuePair<string,DateTime>> emitted=new List<KeyValuePair<string,DateTime>>();
    string geometry="";
    int paints,scrollY,wheelRemainder,dragOffset;
    float scale=1,testScale;
    Rectangle viewport,track,thumb;
    Form testBackdrop;
    Dictionary<string,object> baseline=new Dictionary<string,object>();
    readonly Action<Dictionary<string,object>,Dictionary<string,object>> changed;
    readonly Action closeRequested;
    int Px(float n){return (int)Math.Round(n*scale);}
    int LineHeight {get{return Math.Max(Px(20),(int)Math.Ceiling(bodyFont.GetHeight())+Px(2));}}
    int TotalHeight {get{return lines.Count*LineHeight;}}
    int MaxScroll {get{return Math.Max(0,TotalHeight-viewport.Height);}}
    internal ProgressFrame(Action<Dictionary<string,object>,Dictionary<string,object>> callback,Action onClose){
      changed=callback;closeRequested=onClose;AutoScaleMode=AutoScaleMode.None;FormBorderStyle=FormBorderStyle.None;
      ShowInTaskbar=false;TopMost=true;StartPosition=FormStartPosition.Manual;
      MinimumSize=new Size(240,160);MaximumSize=new Size(1600,1600);
      SetStyle(ControlStyles.UserPaint|ControlStyles.AllPaintingInWmPaint|ControlStyles.OptimizedDoubleBuffer|ControlStyles.ResizeRedraw,true);
      SetFonts(1);LayoutBody();
    }
    void SetFonts(float next){
      if(bodyFont!=null){bodyFont.Dispose();headingFont.Dispose();titleFont.Dispose();footerFont.Dispose();}
      scale=next;bodyFont=new Font("Microsoft YaHei UI",14.667f*scale,FontStyle.Regular,GraphicsUnit.Pixel);
      headingFont=new Font("Microsoft YaHei UI",14.667f*scale,FontStyle.Bold,GraphicsUnit.Pixel);
      titleFont=new Font("Microsoft YaHei UI",14*scale,FontStyle.Bold,GraphicsUnit.Pixel);
      footerFont=new Font("Microsoft YaHei UI",11.5f*scale,FontStyle.Regular,GraphicsUnit.Pixel);
    }
    void RefreshDpi(){
      float next=1;try{next=Native.GetDpiForWindow(Handle)/96f;}catch(EntryPointNotFoundException){}
      if(testScale>0)next=testScale;next=Math.Max(1,Math.Min(4,next));
      if(Math.Abs(next-scale)>.01f){SetFonts(next);LayoutBody();}
    }
    protected override bool ShowWithoutActivation {get{return true;}}
    protected override CreateParams CreateParams {get{var p=base.CreateParams;p.ExStyle|=0x80000|0x80|0x08000000;if(Locked)p.ExStyle|=0x20;return p;}}
    protected override void OnHandleCreated(EventArgs e){base.OnHandleCreated(e);RefreshDpi();Native.ApplyDisplayAffinity(this,remoteVisible);}
    protected override void OnShown(EventArgs e){base.OnShown(e);Present();}
    internal bool ClickThrough {get{return (Native.GetWindowLong(Handle,-20)&0x08000020)==0x08000020;}}
    static string TextValue(Dictionary<string,object> data,string key){object v;if(data==null||!data.TryGetValue(key,out v)||v==null)return "";string s=Convert.ToString(v);return s.Length>1200?s.Substring(s.Length-1200):s;}
    static int NumberValue(Dictionary<string,object> data,string key,int fallback){object v;return data!=null&&data.TryGetValue(key,out v)?Convert.ToInt32(v):fallback;}
    internal void Configure(Dictionary<string,object> settings,bool visible){
      int width=Math.Max(240,Math.Min(1600,NumberValue(settings,"progressOverlayWidth",360))),height=Math.Max(160,Math.Min(1600,NumberValue(settings,"progressOverlayHeight",240)));
      int x=NumberValue(settings,"progressOverlayX",80),y=NumberValue(settings,"progressOverlayY",80),opacity=NumberValue(settings,"progressOverlayOpacity",60);
      string position=TextValue(settings,"progressOverlayPosition");if(position=="")position="top-right";
      object v;bool locked=settings==null||!settings.TryGetValue("progressOverlayLocked",out v)||Convert.ToBoolean(v);
      string signature=width+","+height+","+x+","+y+","+position;
      baseline=new Dictionary<string,object>{{"progressOverlayWidth",width},{"progressOverlayHeight",height},{"progressOverlayX",x},{"progressOverlayY",y},{"progressOverlayPosition",position},{"progressOverlayLocked",locked}};
      if(signature!=geometry){
        // The settings echo each size or position this window reports, about
        // half a second later. An echo of an older report would move the window
        // back if the user has moved or resized it again since (the settings
        // keep the first of two quick reports); keep the window where it is and
        // report its current layout against the settings that just arrived.
        if(position=="custom"&&emitted.Exists(entry=>entry.Key==signature&&(DateTime.UtcNow-entry.Value).TotalSeconds<=10)){
          geometry=signature;if(!sizing&&Bounds!=new Rectangle(x,y,width,height))EmitLayout();
        } else {var area=Screen.PrimaryScreen.WorkingArea;if(position!="custom"){x=position.EndsWith("right")?area.Right-width-20:area.Left+20;y=position.StartsWith("bottom")?area.Bottom-height-20:area.Top+70;}var next=new Rectangle(x,y,width,height);if(Bounds!=next)Bounds=next;geometry=signature;}
      }
      if(!configured||configuredLocked!=locked){SetLocked(locked,false);configuredLocked=locked;}
      configured=true;remoteVisible=visible;BackgroundOpacity=Math.Max(.2,Math.Min(1,opacity/100.0));
      if(IsHandleCreated){Native.ApplyDisplayAffinity(this,visible);RefreshDpi();}Present();
    }
    internal bool IsPreview {get{return previewUnlocked;}}
    internal void BeginPreview(){previewUnlocked=true;SetLocked(false,false);}
    internal void EndPreview(){if(!previewUnlocked)return;previewUnlocked=false;SetLocked(configuredLocked,false);}
    // After any lock the pointer must leave the button before resting on it
    // unlocks again, so clicking the open padlock (or the shortcut) holds.
    internal void SetLocked(bool locked,bool notify){if(notify)previewUnlocked=false;hoverUnlocked=false;hoverBlocked=locked;hoverSince=awaySince=DateTime.MinValue;hoverFraction=0;ApplyLock(locked);if(notify)changed(new Dictionary<string,object>{{"progressOverlayLocked",locked}},new Dictionary<string,object>{{"progressOverlayLocked",configuredLocked}});}
    void ApplyLock(bool locked){Locked=locked;draggingThumb=false;Capture=false;if(IsHandleCreated){int style=Native.GetWindowLong(Handle,-20);Native.SetWindowLong(Handle,-20,locked?style|0x20:style&~0x20);Native.SetWindowPos(Handle,IntPtr.Zero,0,0,0,0,0x37);}LayoutBody();Present();}
    // Clicking the open padlock locks the window now. A temporary unlock (hover
    // or preview) just ends; a window unlocked in the settings saves the locked
    // state, as the lock shortcut does.
    void LockNow(){bool save=!configuredLocked;previewUnlocked=false;SetLocked(true,save);}
    internal bool WantsPointer {get{return Locked||hoverUnlocked;}}
    // True while the user is adjusting the window, which then stays until they are done.
    internal bool Adjusting {get{return hoverUnlocked||sizing||draggingThumb;}}
    Rectangle LockZone {get{return new Rectangle(Width-Px(32),0,Px(32),Px(34));}}
    Rectangle CloseZone {get{return new Rectangle(Width-Px(60),0,Px(28),Px(34));}}
    // The padlock in the top-right corner is the lock button. While the window
    // passes the mouse through, resting the user's own pointer on it for a
    // moment unlocks the window, so it can be moved and resized; once the
    // pointer has been away for a while it locks again. The saved lock setting
    // is not changed, and DSH's own pointer moves never count (userPointer=false).
    internal void TrackPointer(Native.Point cursor,bool userPointer){
      if(IsDisposed)return;
      var now=DateTime.UtcNow;var at=new Point(cursor.x-Left,cursor.y-Top);
      if(Locked){
        bool over=LockZone.Contains(at);
        if(hoverBlocked){if(!over)hoverBlocked=false;return;}
        if(!(userPointer&&over)){if(hoverSince!=DateTime.MinValue){hoverSince=DateTime.MinValue;hoverFraction=0;Present();}return;}
        if(hoverSince==DateTime.MinValue)hoverSince=now;
        float fraction=(float)Math.Min(1,(now-hoverSince).TotalMilliseconds/HoverUnlockMs);
        if(fraction>=1){hoverSince=awaySince=DateTime.MinValue;hoverFraction=0;hoverUnlocked=true;ApplyLock(false);return;}
        if(fraction-hoverFraction>=.04f||hoverFraction==0){hoverFraction=Math.Max(.01f,fraction);Present();}
      } else if(hoverUnlocked){
        var near=new Rectangle(-Px(8),-Px(8),Width+Px(16),Height+Px(16));
        if(near.Contains(at)||sizing||draggingThumb){awaySince=DateTime.MinValue;return;}
        if(awaySince==DateTime.MinValue)awaySince=now;
        else if((now-awaySince).TotalMilliseconds>=HoverRelockMs)SetLocked(true,false);
      }
    }
    internal object HoverStatus(){var zone=LockZone;return new {unlocked=hoverUnlocked,preview=previewUnlocked,configuredLocked=configuredLocked,blocked=hoverBlocked,dwelling=hoverSince!=DateTime.MinValue,fraction=hoverFraction,away=awaySince!=DateTime.MinValue,sizing=sizing,lockZone=new{x=zone.X,y=zone.Y,width=zone.Width,height=zone.Height}};}
    internal void RequestClose(){closeRequested();}
    internal void EmitLayout(){
      var now=DateTime.UtcNow;string signature=Width+","+Height+","+Left+","+Top+",custom";
      emitted.RemoveAll(entry=>entry.Key==signature||(now-entry.Value).TotalSeconds>10);emitted.Add(new KeyValuePair<string,DateTime>(signature,now));
      changed(new Dictionary<string,object>{{"progressOverlayWidth",Width},{"progressOverlayHeight",Height},{"progressOverlayPosition","custom"},{"progressOverlayX",Left},{"progressOverlayY",Top},{"progressOverlayLocked",previewUnlocked||hoverUnlocked?configuredLocked:Locked}},baseline);
    }
    // The reading area holds whole lines only, so no line is ever cut in half
    // at its top or bottom edge. A locked window has no footer line.
    void LayoutBody(){
      if(bodyFont==null)return;
      int top=Px(subheader.Length==0?39:60),lineHeight=LineHeight;
      int available=Math.Max(lineHeight,ClientSize.Height-top-(Locked?Px(8):Px(26)));
      viewport=new Rectangle(Px(12),top,Math.Max(24,ClientSize.Width-Px(36)),Math.Max(1,available/lineHeight)*lineHeight);
      lines.Clear();
      using(var image=new Bitmap(1,1))using(var g=Graphics.FromImage(image))using(var format=(StringFormat)StringFormat.GenericTypographic.Clone()){
        format.FormatFlags|=StringFormatFlags.MeasureTrailingSpaces;
        int widest=Math.Max(8,(int)(viewport.Width/Math.Max(1f,bodyFont.Size*.2f)));
        foreach(string paragraph in bodyText.Replace("\r","").Split('\n')){
          bool heading=Array.IndexOf(headings,paragraph)>=0;Font font=heading?headingFont:bodyFont;
          if(paragraph.Length==0){lines.Add(new ReadingLine("",false));continue;}
          int at=0;while(at<paragraph.Length){
            int lo=1,hi=Math.Min(paragraph.Length-at,widest),best=1;
            while(lo<=hi){int mid=(lo+hi)/2;float width=g.MeasureString(paragraph.Substring(at,mid),font,Int32.MaxValue,format).Width;if(width<=viewport.Width){best=mid;lo=mid+1;}else hi=mid-1;}
            // Keep surrogate pairs and ordinary Latin words together when wrapping.
            if(at+best<paragraph.Length&&best>1&&Char.IsHighSurrogate(paragraph[at+best-1]))best--;
            if(at+best<paragraph.Length&&best>1&&"，。！？；：、）】》…,.!?;:)".IndexOf(paragraph[at+best])>=0)best--;
            if(at+best<paragraph.Length&&Char.IsLetterOrDigit(paragraph[at+best])&&paragraph[at+best]<128){int space=paragraph.LastIndexOf(' ',at+best-1,best);if(space>at+best/2)best=space-at+1;}
            lines.Add(new ReadingLine(paragraph.Substring(at,best),heading));at+=best;
          }
        }
      }
      scrollY=followOutput?MaxScroll:Snap(Math.Min(scrollY,MaxScroll));LayoutScrollbar();
    }
    int Snap(int y){int lineHeight=Math.Max(1,LineHeight);return (int)Math.Round(y/(double)lineHeight)*lineHeight;}
    void LayoutScrollbar(){track=new Rectangle(Width-Px(16),viewport.Y,Px(6),viewport.Height);int height=Math.Min(track.Height,Math.Max(Px(26),(int)((long)track.Height*viewport.Height/Math.Max(1,TotalHeight))));thumb=new Rectangle(track.X,track.Y+(MaxScroll==0?0:(int)((long)(track.Height-height)*scrollY/MaxScroll)),track.Width,height);}
    void ScrollTo(int y){scrollY=Math.Max(0,Math.Min(MaxScroll,Snap(y)));followOutput=scrollY>=MaxScroll-2;LayoutScrollbar();Present();}
    protected override void OnResize(EventArgs e){base.OnResize(e);LayoutBody();Present();}
    protected override void OnLocationChanged(EventArgs e){base.OnLocationChanged(e);if(IsHandleCreated){RefreshDpi();Present();}}
    protected override void OnResizeEnd(EventArgs e){base.OnResizeEnd(e);if(!Locked)EmitLayout();}
    protected override void OnMouseDown(MouseEventArgs e){
      if(!Locked&&e.Button==MouseButtons.Left){if(LockZone.Contains(e.Location)){LockNow();return;}if(CloseZone.Contains(e.Location)){closeRequested();return;}if(e.X>=track.X-Px(6)&&e.Y>=track.Top&&e.Y<track.Bottom&&MaxScroll>0){if(thumb.Contains(e.Location)){draggingThumb=true;dragOffset=e.Y-thumb.Top;Capture=true;}else ScrollTo(scrollY+(e.Y<thumb.Top?-viewport.Height:viewport.Height));return;}}
      base.OnMouseDown(e);
    }
    protected override void OnMouseMove(MouseEventArgs e){if(draggingThumb&&!Locked)ScrollTo((int)((long)(e.Y-dragOffset-track.Top)*MaxScroll/Math.Max(1,track.Height-thumb.Height)));base.OnMouseMove(e);}
    protected override void OnMouseUp(MouseEventArgs e){draggingThumb=false;Capture=false;base.OnMouseUp(e);}
    protected override void OnMouseCaptureChanged(EventArgs e){if(!Capture)draggingThumb=false;base.OnMouseCaptureChanged(e);}
    protected override void WndProc(ref Message m){
      if(m.Msg==0x21){m.Result=new IntPtr(3);return;}
      if(m.Msg==0x020a){if(!Locked)ScrollWheel((short)(m.WParam.ToInt64()>>16));m.Result=IntPtr.Zero;return;}
      if(m.Msg==0x02e0){base.WndProc(ref m);RefreshDpi();Present();return;}
      if(m.Msg==0x0231)sizing=true;else if(m.Msg==0x0232)sizing=false;
      if(m.Msg==0x84){if(Locked){m.Result=new IntPtr(-1);return;}long value=m.LParam.ToInt64();int x=(short)(value&0xffff)-Left,y=(short)((value>>16)&0xffff)-Top;int edge=Px(6);if(x>=Width-Px(60)&&y<Px(34)){m.Result=new IntPtr(1);return;}int hit=y<edge?(x<edge?13:x>=Width-edge?14:12):y>=Height-edge?(x<edge?16:x>=Width-edge?17:15):x<edge?10:x>=Width-edge?11:y<Px(35)?2:1;m.Result=new IntPtr(hit);return;}
      base.WndProc(ref m);
    }
    static List<Dictionary<string,object>> Items(Dictionary<string,object> data,string key){
      var items=new List<Dictionary<string,object>>();object value;
      if(data==null||!data.TryGetValue(key,out value)||value==null||value is string)return items;
      var list=value as System.Collections.IEnumerable;if(list==null)return items;
      foreach(object item in list){var entry=item as Dictionary<string,object>;if(entry!=null)items.Add(entry);}
      return items;
    }
    static bool Flag(Dictionary<string,object> data,string key){object v;if(data==null||!data.TryGetValue(key,out v)||v==null)return false;try{return Convert.ToBoolean(v);}catch(FormatException){return false;}}
    internal static long Whole(Dictionary<string,object> data,string key){object v;if(data==null||!data.TryGetValue(key,out v)||v==null)return 0;try{return Convert.ToInt64(v);}catch(FormatException){return 0;}catch(InvalidCastException){return 0;}catch(OverflowException){return 0;}}
    static string Shorten(string text,int limit){text=text.Trim();return text.Length>limit?"…"+text.Substring(text.Length-limit+1):text;}
    // DSH renders Markdown, so plain text shows the same words without the
    // marks; paragraphs follow each other without blank lines in a small window.
    static readonly System.Text.RegularExpressions.Regex RxCodeFence=new System.Text.RegularExpressions.Regex(@"(?m)^[ \t]*```[^\n]*\n?",System.Text.RegularExpressions.RegexOptions.Compiled);
    static readonly System.Text.RegularExpressions.Regex RxImage=new System.Text.RegularExpressions.Regex(@"!\[([^\]\n]*)\]\([^)\n]*\)",System.Text.RegularExpressions.RegexOptions.Compiled);
    static readonly System.Text.RegularExpressions.Regex RxLink=new System.Text.RegularExpressions.Regex(@"\[([^\]\n]+)\]\([^)\n]*\)",System.Text.RegularExpressions.RegexOptions.Compiled);
    static readonly System.Text.RegularExpressions.Regex RxBold=new System.Text.RegularExpressions.Regex(@"(\*\*|__)(?=\S)(.+?)(?<=\S)\1",System.Text.RegularExpressions.RegexOptions.Compiled);
    static readonly System.Text.RegularExpressions.Regex RxCode=new System.Text.RegularExpressions.Regex(@"`([^`\n]+)`",System.Text.RegularExpressions.RegexOptions.Compiled);
    static readonly System.Text.RegularExpressions.Regex RxHeading=new System.Text.RegularExpressions.Regex(@"(?m)^[ \t]{0,3}#{1,6}[ \t]+",System.Text.RegularExpressions.RegexOptions.Compiled);
    static readonly System.Text.RegularExpressions.Regex RxBullet=new System.Text.RegularExpressions.Regex(@"(?m)^([ \t]*)[-*+][ \t]+",System.Text.RegularExpressions.RegexOptions.Compiled);
    static readonly System.Text.RegularExpressions.Regex RxBlankLines=new System.Text.RegularExpressions.Regex(@"\n[ \t]*(?:\n[ \t]*)+",System.Text.RegularExpressions.RegexOptions.Compiled);
    static string Readable(string text){
      text=(text??"").Replace("\r","");
      text=RxCodeFence.Replace(text,"");
      text=RxImage.Replace(text,match=>match.Groups[1].Value.Trim()==""?Words.Get("image"):Words.Format("imageNamed",match.Groups[1].Value.Trim()));
      text=RxLink.Replace(text,"$1");
      text=RxBold.Replace(text,"$2");
      text=RxCode.Replace(text,"$1");
      text=RxHeading.Replace(text,"");
      text=RxBullet.Replace(text,"$1• ");
      text=RxBlankLines.Replace(text,"\n");
      return text.Trim();
    }
    // When a task ends with a reply longer than the window, show the reply from
    // its first line (the result) rather than its last; a reader who scrolled
    // away keeps their place. The reply heading is kept from the update that
    // wrote it, so a language switch cannot hide it.
    string replyHeading="";
    void RevealResult(bool finished){
      if(!finished){revealedResult=false;return;}
      if(revealedResult||!followOutput)return;
      int at=-1;for(int i=lines.Count-1;i>=0;i--)if(lines[i].heading&&lines[i].text==replyHeading){at=i;break;}
      if(at<0)return;
      revealedResult=true;
      if(TotalHeight-at*LineHeight>viewport.Height){scrollY=Math.Min(MaxScroll,at*LineHeight);followOutput=false;LayoutScrollbar();}
    }
    // One heading per model step ("Step 3 · Scroll the page"), then the text DSH
    // showed for that step. Older steps keep only their last lines; the current
    // step and the reply are shown in full.
    static string StepHeading(Dictionary<string,object> entry){
      var labels=new List<string>();
      foreach(var action in Items(entry,"actions")){string label=TextValue(action,"label");if(label!="")labels.Add(TextValue(action,"state")=="error"?Words.Format("actionError",label):label);}
      string step=TextValue(entry,"step");
      return labels.Count>0?Words.Format("stepActions",step,String.Join(Words.Get("listSeparator"),labels.ToArray())):Words.Format("stepHeading",step);
    }
    static string DoneHeaderKey(string step){long n;if(!long.TryParse(step,out n))return "headerDone";long a=Math.Abs(n),m10=a%10,m100=a%100;if(n==1)return "headerDoneOne";if(m10>=2&&m10<=4&&(m100<12||m100>14))return "headerDoneFew";return "headerDone";}
    internal void UpdateProgress(Dictionary<string,object> data){
      string status=TextValue(data,"status");
      string step=TextValue(data,"step");if(step==""||step=="0")step="1";
      long started=Whole(data,"startedAt"),ended=Whole(data,"endedAt");
      bool finished=ended>0&&(status=="done"||status=="failed"||status=="stopped");
      string took=started>0&&ended>=started?Words.Format("took",Math.Max(1,(long)Math.Round((ended-started)/1000.0))):"";
      if(finished)header=status=="done"?Words.Format(DoneHeaderKey(step),step,took):Words.Format(status=="failed"?"headerFailed":"headerStopped",step);
      else header=Words.Format("headerWorking",step,Words.Get(status=="thinking"?"statusThinking":status=="acting"?"statusActing":status=="replying"?"statusReplying":status=="stopped"?"statusStopped":"statusWorking"));
      // The plugin names each action; a bare tool name stands in for one it did not name.
      string action=TextValue(data,"action");if(action=="")action=TextValue(data,"tool");
      subheader=finished?"":action;
      replyHeading=Words.Get("replyHeading");
      var steps=Items(data,"steps");var text=new List<string>();var heads=new List<string>();
      Action<string> head=delegate(string value){text.Add(value);heads.Add(value);};
      if(TextValue(data,"displayMode")=="summary"){
        // Summary mode: the AI summaries in order, newest last. Until the first
        // one arrives (or when the model is unavailable) the step names stand in.
        var summaries=Items(data,"summaries");string latest="";
        foreach(var item in summaries){string value=Readable(TextValue(item,"text"));if(value==""||value==latest)continue;head(Flag(item,"final")?Words.Get("summaryResult"):Words.Format("summaryStep",TextValue(item,"step")));text.Add(value);latest=value;}
        bool finalSummary=summaries.Count>0&&Flag(summaries[summaries.Count-1],"final");
        if(latest==""){
          foreach(var entry in steps)head(StepHeading(entry));
          string summaryStatus=TextValue(data,"summaryStatus");
          text.Add(Words.Get(summaryStatus=="unavailable"?"summaryUnavailable":finished?"summarizingResult":"summarizing"));
        }
        string reply=Readable(steps.Count>0?TextValue(steps[steps.Count-1],"reply"):TextValue(data,"reply"));
        if(finished&&!finalSummary&&reply!=""&&TextValue(data,"summaryStatus")!="working"){head(replyHeading);text.Add(reply);}
      } else if(steps.Count>0){
        int shown=Math.Max(0,steps.Count-12);
        for(int i=shown;i<steps.Count;i++){
          var entry=steps[i];bool current=i==steps.Count-1;head(StepHeading(entry));
          string reasoning=Readable(TextValue(entry,"reasoning")),reply=Readable(TextValue(entry,"reply"));
          if(reasoning!="")text.Add(current?reasoning:Shorten(reasoning,240));
          if(reply!=""){head(replyHeading);text.Add(reply);}
        }
      } else {
        string reasoning=Readable(TextValue(data,"reasoning")),reply=Readable(TextValue(data,"reply"));
        if(reasoning!=""){head(Words.Get("thinkingHeading"));text.Add(reasoning);}
        if(reply!=""){head(replyHeading);text.Add(reply);}
      }
      bodyText=text.Count>0?String.Join("\n",text.ToArray()):Words.Get("waiting");headings=heads.ToArray();
      Content=header+"\n"+subheader+"\n\n"+bodyText;LayoutBody();RevealResult(finished);Present();
    }
    // A dark halo under light text keeps it readable when a bright page shows
    // through the translucent background.
    static void Shadowed(Graphics g,string text,Font font,Brush brush,Brush shadow,RectangleF where,StringFormat format,float offset){
      g.DrawString(text,font,shadow,new RectangleF(where.X+offset,where.Y+offset,where.Width,where.Height),format);g.DrawString(text,font,brush,where,format);
    }
    // The lock button stays in the top-right corner: a closed padlock while
    // the mouse passes through (a ring fills while the pointer rests on it),
    // an open one (click to lock) with Close beside it while unlocked.
    void DrawButtons(Graphics g,Pen closePen){
      float cx=Width-scale*19,cy=scale*18,r=scale*12;var disc=new RectangleF(cx-r,cy-r,2*r,2*r);
      using(var brush=new SolidBrush(Color.FromArgb(Locked?(hoverFraction>0?76:34):52,220,229,242)))g.FillEllipse(brush,disc);
      if(Locked&&hoverFraction>0)using(var ring=new Pen(Color.FromArgb(245,122,180,255),Math.Max(1.5f,scale*2))){g.DrawArc(ring,disc.X+scale,disc.Y+scale,disc.Width-2*scale,disc.Height-2*scale,-90,360*hoverFraction);}
      Color ink=Locked?Color.FromArgb(220,196,208,224):Color.FromArgb(245,238,242,248);
      float lift=Locked?0:scale*3;
      using(var pen=new Pen(ink,Math.Max(1f,scale*1.3f)))using(var fill=new SolidBrush(ink)){
        g.DrawArc(pen,cx-scale*3.5f,cy-scale*7-lift,scale*7,scale*9,180,180);
        if(lift>0)g.DrawLine(pen,cx-scale*3.5f,cy-scale*2.5f-lift,cx-scale*3.5f,cy-scale*2);
        using(var body=Frame.Rounded(new RectangleF(cx-scale*5.5f,cy-scale*2,scale*11,scale*8),Math.Max(1,scale*1.5f)))g.FillPath(fill,body);
      }
      if(!Locked){float x=Width-scale*46,y=scale*17.5f,d=scale*4.5f;g.DrawLine(closePen,x-d,y-d,x+d,y+d);g.DrawLine(closePen,x-d,y+d,x+d,y-d);}
    }
    Bitmap DrawSurface(){
      var image=new Bitmap(Math.Max(1,Width),Math.Max(1,Height),PixelFormat.Format32bppPArgb);
      using(var g=Graphics.FromImage(image)){
        g.Clear(Color.Transparent);g.SmoothingMode=SmoothingMode.AntiAlias;g.TextRenderingHint=TextRenderingHint.AntiAliasGridFit;
        using(var shape=Frame.Rounded(new RectangleF(.5f,.5f,Width-1,Height-1),Px(8)))using(var bg=new SolidBrush(Color.FromArgb((int)Math.Round(BackgroundOpacity*255),25,29,38)))using(var border=new Pen(Color.FromArgb(140,117,161,218),1)){g.FillPath(bg,shape);g.DrawPath(border,shape);}
        using(var fg=new SolidBrush(Color.FromArgb(255,246,247,250)))using(var muted=new SolidBrush(Color.FromArgb(245,185,198,216)))using(var shadow=new SolidBrush(Color.FromArgb(150,0,0,0)))using(var pen=new Pen(Color.FromArgb(235,203,216,232),Px(1.3f)))using(var format=(StringFormat)StringFormat.GenericTypographic.Clone()){
          format.FormatFlags|=StringFormatFlags.NoWrap|StringFormatFlags.MeasureTrailingSpaces;format.Trimming=StringTrimming.EllipsisCharacter;
          float halo=Math.Max(1f,scale*.75f);
          Shadowed(g,header,titleFont,fg,shadow,new RectangleF(Px(12),Px(10),Math.Max(10,Width-Px(Locked?52:68)),Px(24)),format,halo);
          DrawButtons(g,pen);
          if(subheader!="")Shadowed(g,subheader,footerFont,muted,shadow,new RectangleF(Px(12),Px(36),Math.Max(10,Width-Px(24)),Px(21)),format,halo);
          var clip=g.Save();g.SetClip(viewport);int first=scrollY/LineHeight,last=Math.Min(lines.Count,(scrollY+viewport.Height)/LineHeight+1);
          for(int i=first;i<last;i++){var line=lines[i];Font font=line.heading?headingFont:bodyFont;Brush brush=line.heading?muted:fg;float x=viewport.X,y=viewport.Y+i*LineHeight-scrollY;g.DrawString(line.text,font,shadow,new PointF(x+halo,y+halo),format);g.DrawString(line.text,font,brush,new PointF(x,y),format);}
          g.Restore(clip);
          if(!Locked)Shadowed(g,Words.Get(hoverUnlocked?"hintUnlocked":previewUnlocked?"hintPreview":"hintAdjust"),footerFont,muted,shadow,new RectangleF(Px(12),Height-Px(22),Math.Max(10,Width-Px(24)),Px(20)),format,halo);
        }
        // The translucent scrollbar appears only when there is more to read.
        if(MaxScroll>0){
          using(var shape=Frame.Rounded(track,Math.Max(1,Px(3))))using(var brush=new SolidBrush(Color.FromArgb(32,220,229,242)))g.FillPath(brush,shape);
          using(var shape=Frame.Rounded(thumb,Math.Max(1,Px(3))))using(var brush=new SolidBrush(Color.FromArgb(112,220,229,242)))g.FillPath(brush,shape);
        }
      }return image;
    }
    void Present(){
      if(presenting||!IsHandleCreated||IsDisposed||Width<1||Height<1)return;presenting=true;
      try{using(var image=DrawSurface()){IntPtr dc=Native.CreateCompatibleDC(IntPtr.Zero),bitmap=image.GetHbitmap(Color.FromArgb(0)),previous=Native.SelectObject(dc,bitmap);try{var dest=new Native.Point(Left,Top);var origin=new Native.Point(0,0);var size=new Native.Size(Width,Height);var blend=new Native.Blend{op=0,flags=0,alpha=255,format=1};if(!Native.UpdateLayeredWindow(Handle,IntPtr.Zero,ref dest,ref size,dc,ref origin,0,ref blend,2))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(),"Could not present progress overlay");paints++;}finally{Native.SelectObject(dc,previous);Native.DeleteObject(bitmap);Native.DeleteDC(dc);}}}finally{presenting=false;}
    }
    protected override void OnPaint(PaintEventArgs e){Present();}
    internal object ReadingStatus(){return new {scrollbar=true,position=scrollY,maximum=Math.Max(0,TotalHeight-1),page=viewport.Height,atBottom=scrollY>=MaxScroll-2,following=followOutput,text=bodyText,lineHeight=LineHeight,emPixels=bodyFont.Size,viewport=new{x=viewport.X,y=viewport.Y,width=viewport.Width,height=viewport.Height},resizeRedraw=GetStyle(ControlStyles.ResizeRedraw),paints=paints,dpiScale=scale,textAlpha=255,backgroundAlpha=(int)Math.Round(BackgroundOpacity*255),scrollbarTrackAlpha=MaxScroll>0?32:0,scrollbarThumbAlpha=MaxScroll>0?112:0,thumb=new{x=thumb.X,y=thumb.Y,width=thumb.Width,height=thumb.Height},wrappedLines=lines.Count};}
    internal void ScrollLines(int count){ScrollTo(scrollY+count*LineHeight);}
    internal void ScrollWheel(int delta){wheelRemainder+=delta;int notches=wheelRemainder/120;wheelRemainder%=120;if(notches!=0){int n=SystemInformation.MouseWheelScrollLines;ScrollTo(scrollY-notches*(n<0?viewport.Height:Math.Max(1,n)*LineHeight));}}
    internal int TestHitAt(int x,int y){return Native.SendMessage(Handle,0x0084,IntPtr.Zero,new IntPtr(((Top+y)&0xffff)<<16|((Left+x)&0xffff))).ToInt32();}
    internal void TestCloseClick(){Native.SendMessage(Handle,0x0201,new IntPtr(1),new IntPtr((Px(18)<<16)|(Width-Px(46))));}
    internal void TestLockClick(){Native.SendMessage(Handle,0x0201,new IntPtr(1),new IntPtr((Px(18)<<16)|(Width-Px(18))));}
    internal void TestResizeRedraw(bool enabled){SetStyle(ControlStyles.ResizeRedraw,enabled);}
    internal void TestDpi(float next){testScale=next;RefreshDpi();Present();}
    internal void TestScrollbar(int x,int y,int endY){OnMouseDown(new MouseEventArgs(MouseButtons.Left,1,x,y,0));OnMouseMove(new MouseEventArgs(MouseButtons.Left,0,x,endY,0));OnMouseUp(new MouseEventArgs(MouseButtons.Left,1,x,endY,0));}
    sealed class TestBackdrop : Form {protected override bool ShowWithoutActivation {get{return true;}}}
    internal void ShowTestBackdrop(){if(testBackdrop==null){testBackdrop=new TestBackdrop{FormBorderStyle=FormBorderStyle.None,ShowInTaskbar=false,TopMost=true,BackColor=Color.FromArgb(40,40,40),StartPosition=FormStartPosition.Manual,Bounds=new Rectangle(Left-4,Top-4,1000,900)};testBackdrop.Show();Native.KeepOnTop(Handle);}}
    internal object CaptureProgress(string path,bool screen){
      if(screen&&testBackdrop==null)throw new InvalidOperationException("Screen capture requires a synthetic backdrop");
      using(var bitmap=DrawSurface()){if(screen)using(var g=Graphics.FromImage(bitmap)){g.CompositingMode=CompositingMode.SourceCopy;g.CopyFromScreen(Left,Top,0,0,new Size(Width,Height));}int stray=0;for(int y=Px(8);y<Math.Min(Px(34),Height);y++)for(int x=Px(12);x<Width-Px(55);x++){Color c=bitmap.GetPixel(x,y);if(c.B-c.R>65&&c.B-c.G>20)stray++;}bitmap.Save(path,ImageFormat.Png);return new {strayHeaderPixels=stray,width=Width,height=Height};}
    }
    protected override void Dispose(bool disposing){if(disposing){if(testBackdrop!=null)testBackdrop.Dispose();if(bodyFont!=null){bodyFont.Dispose();headingFont.Dispose();titleFont.Dispose();footerFont.Dispose();}}base.Dispose(disposing);}
  }


  // A small cursor-following layer. The system cursor, theme and input state
  // remain owned by Windows; closing/crashing this process leaves no cursor changes.
  internal sealed class PointerFrame : Form {
    IntPtr dc, bitmap, previous;
    float scale;
    bool flipX, flipY;
    Rectangle lastBounds;
    byte lastAlpha;
    SizeF lastExtent;
    bool remoteVisible;
    internal PointerFrame(bool visible) {
      remoteVisible=visible;
      AutoScaleMode = AutoScaleMode.None; FormBorderStyle = FormBorderStyle.None;
      ShowInTaskbar = false; TopMost = true; StartPosition = FormStartPosition.Manual;
      Bounds = new Rectangle(0,0,1,1);
      dc = Native.CreateCompatibleDC(IntPtr.Zero);
    }
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams {
      get { var value=base.CreateParams; value.ExStyle|=0x80000|0x20|0x80|0x08000000; return value; }
    }
    protected override void OnHandleCreated(EventArgs e) { base.OnHandleCreated(e); SetRemoteVisible(remoteVisible); }
    internal void SetRemoteVisible(bool visible) {remoteVisible=visible;Native.ApplyDisplayAffinity(this,visible);}
    internal bool ClickThrough { get { return (Native.GetWindowLong(Handle,-20)&0x08080020)==0x08080020; } }
    internal bool CaptureExcluded { get { uint affinity; return Native.GetWindowDisplayAffinity(Handle,out affinity)&&affinity==0x11; } }
    // Geometry in 96-DPI units. The tag sits just past the pointer's visible
    // extent; the canvas grows with it, and the default arrow keeps 120x84.
    static float TagX(SizeF extent) { return Math.Max(13f,extent.Width+2); }
    static float TagY(SizeF extent) { return Math.Max(17f,extent.Height-1); }
    static float CanvasWidth(SizeF extent) { return Math.Max(120f,24+TagX(extent)+48); }
    static float CanvasHeight(SizeF extent) { return Math.Max(84f,24+TagY(extent)+27); }
    static bool FlipX(Native.Point point, Rectangle screen, float zoom, SizeF extent) { return screen.Right-point.x < (CanvasWidth(extent)-24)*zoom; }
    static bool FlipY(Native.Point point, Rectangle screen, float zoom, SizeF extent) { return screen.Bottom-point.y < (CanvasHeight(extent)-18)*zoom; }
    internal static Rectangle LayoutForPoint(Native.Point point, Rectangle screen, float zoom) { return LayoutForPoint(point,screen,zoom,SizeF.Empty); }
    internal static Rectangle LayoutForPoint(Native.Point point, Rectangle screen, float zoom, SizeF extent) {
      float canvasWidth=CanvasWidth(extent),canvasHeight=CanvasHeight(extent);
      int width=(int)Math.Ceiling(canvasWidth*zoom),height=(int)Math.Ceiling(canvasHeight*zoom);
      int centerX=(int)Math.Round((FlipX(point,screen,zoom,extent)?canvasWidth-24:24)*zoom),centerY=(int)Math.Round((FlipY(point,screen,zoom,extent)?canvasHeight-24:24)*zoom);
      return new Rectangle(point.x-centerX,point.y-centerY,width,height);
    }
    // The user's pointer size: the arrow's visible extent past its hotspot, in
    // 96-DPI units. Measured once, and again only after Windows reports a
    // preference change (pointer size or cursor scheme).
    static SizeF? pointerExtent;
    internal static void ForgetPointerSize() { pointerExtent=null; }
    internal static SizeF PointerExtent() {
      if(!pointerExtent.HasValue) {
        var measured=MeasureCursor(Native.LoadCursor(IntPtr.Zero,new IntPtr(32512)));
        float dpi=96; try { dpi=Native.GetDpiForSystem(); } catch(EntryPointNotFoundException) { }
        // Windows enlarges the accessibility pointer when drawing it, not in the
        // arrow image; SPI_GETCURSORBASESIZE reports that size (32 by default).
        int baseSize; if(!Native.SystemParametersInfo(0x2028,0,out baseSize,0)||baseSize<32)baseSize=32;
        float factor=Math.Min(8f,baseSize/32f)/Math.Max(1f,dpi/96f);
        pointerExtent=new SizeF(measured.Width*factor,measured.Height*factor);
      }
      return pointerExtent.Value;
    }
    // Visible pixels past the hotspot, in physical pixels.
    internal static SizeF MeasureCursor(IntPtr cursor) {
      Native.IconInfo info;
      if(cursor==IntPtr.Zero||!Native.GetIconInfo(cursor,out info))return SizeF.Empty;
      try {
        using(var icon=Icon.FromHandle(cursor))
        using(var image=icon.ToBitmap()) {
          var data=image.LockBits(new Rectangle(0,0,image.Width,image.Height),ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb);
          int right=-1,bottom=-1;
          try {
            int row=Math.Abs(data.Stride)/4;var pixels=new int[row*image.Height];
            Marshal.Copy(data.Scan0,pixels,0,pixels.Length);
            for(int y=0;y<image.Height;y++)for(int x=0;x<image.Width;x++)if(((pixels[y*row+x]>>24)&0xff)>40){if(x>right)right=x;if(y>bottom)bottom=y;}
          } finally { image.UnlockBits(data); }
          // A monochrome pointer draws without alpha; size it from its cell like the arrow.
          if(right<0)return new SizeF(Math.Max(0,image.Width*.375f-info.hotX),Math.Max(0,image.Height*.6f-info.hotY));
          return new SizeF(Math.Max(0,right-info.hotX+1),Math.Max(0,bottom-info.hotY+1));
        }
      } catch(ArgumentException) { return SizeF.Empty; }
      catch(ExternalException) { return SizeF.Empty; }
      finally {
        if(info.mask!=IntPtr.Zero)Native.DeleteObject(info.mask);
        if(info.color!=IntPtr.Zero)Native.DeleteObject(info.color);
      }
    }
    internal void Update(Native.Point point, byte alpha) {
      var screen=Native.DisplayFromPoint(point);
      uint dpiX=96,dpiY=96; try { if(Native.GetDpiForMonitor(Native.MonitorFromPoint(point,2),0,out dpiX,out dpiY)!=0)dpiX=96; } catch(EntryPointNotFoundException) { }
      float zoom=Math.Max(1f,Math.Min(3f,dpiX/96f));
      var extent=PointerExtent();
      bool nextFlipX=FlipX(point,screen,zoom,extent),nextFlipY=FlipY(point,screen,zoom,extent);
      bool redraw=bitmap==IntPtr.Zero||Math.Abs(scale-zoom)>.01f||flipX!=nextFlipX||flipY!=nextFlipY||extent!=lastExtent;
      if(redraw) {
        using(var image=Draw(zoom,nextFlipX,nextFlipY,extent)) {
          IntPtr next=image.GetHbitmap(Color.FromArgb(0));
          IntPtr selected=Native.SelectObject(dc,next);
          if(bitmap==IntPtr.Zero)previous=selected; else Native.DeleteObject(bitmap);
          bitmap=next;
        }
        scale=zoom;flipX=nextFlipX;flipY=nextFlipY;lastExtent=extent;
      }
      var bounds=LayoutForPoint(point,screen,zoom,extent);
      if(!redraw&&bounds==lastBounds&&alpha==lastAlpha)return;
      var destination=new Native.Point(bounds.X,bounds.Y);var origin=new Native.Point(0,0);var size=new Native.Size(bounds.Width,bounds.Height);
      var blend=new Native.Blend { op=0,flags=0,alpha=alpha,format=1 };
      if(!Native.UpdateLayeredWindow(Handle,IntPtr.Zero,ref destination,ref size,dc,ref origin,0,ref blend,2))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(),"Could not present pointer indicator");
      lastBounds=bounds;lastAlpha=alpha;
    }
    internal static Bitmap Draw(float zoom,bool left,bool up) { return Draw(zoom,left,up,SizeF.Empty); }
    internal static Bitmap Draw(float zoom,bool left,bool up,SizeF extent) {
      float canvasWidth=CanvasWidth(extent),canvasHeight=CanvasHeight(extent);
      var image=new Bitmap((int)Math.Ceiling(canvasWidth*zoom),(int)Math.Ceiling(canvasHeight*zoom),PixelFormat.Format32bppPArgb);
      using(var g=Graphics.FromImage(image)) {
        g.Clear(Color.Transparent);g.SmoothingMode=SmoothingMode.AntiAlias;g.TextRenderingHint=TextRenderingHint.AntiAliasGridFit;g.ScaleTransform(zoom,zoom);
        float x=left?canvasWidth-24:24,y=up?canvasHeight-24:24;
        // A soft spotlight under the tip instead of a hard ring.
        using(var spot=new GraphicsPath()) {
          spot.AddEllipse(x-16,y-16,32,32);
          using(var glow=new PathGradientBrush(spot) { CenterColor=Color.FromArgb(120,86,134,254), SurroundColors=new[] { Color.FromArgb(0,86,134,254) } }) g.FillPath(glow,spot);
        }
        // A solid name tag just past the arrow, like collaborative cursors.
        using(var font=new Font("Segoe UI",10,FontStyle.Bold,GraphicsUnit.Pixel))
        using(var format=new StringFormat(StringFormat.GenericTypographic) { Alignment=StringAlignment.Center, LineAlignment=StringAlignment.Center }) {
          float w=(float)Math.Ceiling(g.MeasureString("DSH",font,PointF.Empty,format).Width)+14,h=19;
          // Below-right clears the pointer's whole extent; the other corners only need to clear the tip.
          float bx=left?x-8-w:up?x+13:x+TagX(extent),by=up?y-10-h:left?y+17:y+TagY(extent);
          using(var shadow=Frame.Rounded(new RectangleF(bx,by+1.5f,w,h),6)) using(var brush=new SolidBrush(Color.FromArgb(60,0,0,0))) g.FillPath(brush,shadow);
          using(var shape=TagShape(new RectangleF(bx,by,w,h),left,up)) {
            using(var fill=new SolidBrush(Color.FromArgb(255,57,100,254)))g.FillPath(fill,shape);
            using(var outline=new Pen(Color.FromArgb(240,255,255,255),1.25f))g.DrawPath(outline,shape);
          }
          using(var brush=new SolidBrush(Color.White))g.DrawString("DSH",font,brush,new RectangleF(bx,by+.5f,w,h),format);
        }
      }
      return image;
    }
    // The corner nearest the pointer stays tight, so the tag reads as attached.
    static GraphicsPath TagShape(RectangleF r,bool left,bool up) {
      float topLeft=!left&&!up?2:6,topRight=left&&!up?2:6,bottomRight=left&&up?2:6,bottomLeft=!left&&up?2:6;
      var p=new GraphicsPath();
      p.AddArc(r.X,r.Y,topLeft*2,topLeft*2,180,90);p.AddArc(r.Right-topRight*2,r.Y,topRight*2,topRight*2,270,90);
      p.AddArc(r.Right-bottomRight*2,r.Bottom-bottomRight*2,bottomRight*2,bottomRight*2,0,90);p.AddArc(r.X,r.Bottom-bottomLeft*2,bottomLeft*2,bottomLeft*2,90,90);
      p.CloseFigure();return p;
    }
    protected override void Dispose(bool disposing) {
      if(dc!=IntPtr.Zero) { if(bitmap!=IntPtr.Zero){Native.SelectObject(dc,previous);Native.DeleteObject(bitmap);}Native.DeleteDC(dc);dc=IntPtr.Zero; }
      base.Dispose(disposing);
    }
  }

  internal sealed class Frame : Form {
    readonly Rectangle rectangle;
    bool remoteVisible;
    IntPtr dc, bitmap, previous;
    internal Frame(Rectangle bounds, string text, string position, bool visible, string stopShortcut = "", float dpiScale = 0f) {
      remoteVisible=visible;rectangle = bounds; AutoScaleMode=AutoScaleMode.None;FormBorderStyle = FormBorderStyle.None;
      ShowInTaskbar = false; TopMost = true; StartPosition = FormStartPosition.Manual;
      Bounds=bounds;
      using (var image = Draw(bounds.Width, bounds.Height, text, position, stopShortcut, dpiScale)) bitmap = image.GetHbitmap(Color.FromArgb(0));
      dc = Native.CreateCompatibleDC(IntPtr.Zero); previous = Native.SelectObject(dc, bitmap);
    }
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams {
      get { var value = base.CreateParams; value.ExStyle |= 0x80000 | 0x20 | 0x80 | 0x08000000; return value; }
    }
    protected override void OnHandleCreated(EventArgs e) { base.OnHandleCreated(e); SetRemoteVisible(remoteVisible); }
    internal void SetRemoteVisible(bool visible) {remoteVisible=visible;Native.ApplyDisplayAffinity(this,visible);}
    internal Rectangle DisplayBounds {get{return rectangle;}}
    internal bool CaptureExcluded { get { uint affinity;return Native.GetWindowDisplayAffinity(Handle,out affinity)&&affinity==0x11; } }
    internal bool ClickThrough {get{return (Native.GetWindowLong(Handle,-20)&0x08080020)==0x08080020;}}
    internal void Present(byte alpha) {
      if (IsDisposed) return;
      var destination = new Native.Point(rectangle.X, rectangle.Y); var origin = new Native.Point(0,0);
      var size = new Native.Size(rectangle.Width,rectangle.Height);
      var blend = new Native.Blend { op=0, flags=0, alpha=alpha, format=1 };
      if (!Native.UpdateLayeredWindow(Handle, IntPtr.Zero, ref destination, ref size, dc, ref origin, 0, ref blend, 2)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "Could not present takeover overlay");
    }
    internal static Bitmap Draw(int width, int height, string text, string position) {
      return Draw(width, height, text, position, "", 0f);
    }
    internal static Bitmap Draw(int width, int height, string text, string position, string stopShortcut = "", float dpiScale = 0f) {
      var image = new Bitmap(width,height,PixelFormat.Format32bppPArgb);
      using (var g = Graphics.FromImage(image)) {
        g.SmoothingMode = SmoothingMode.AntiAlias;
        // ClearType needs an opaque surface; layered windows need grayscale text.
        g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
        g.Clear(Color.Transparent);
        float scale = dpiScale > 0f ? dpiScale : Math.Max(1f, Math.Min(2f, width/1920f));
        // Edge glow: a bright core line that reads on dark wallpapers, then a
        // DeepSeek-blue falloff that reads on light ones.
        g.CompositingMode = CompositingMode.SourceCopy;
        int core = (int)Math.Round(2*scale), glow = core+(int)Math.Round(18*scale);
        for (int i=0;i<glow;i++) {
          var color = i<core ? Color.FromArgb(235,150,184,255) : Color.FromArgb((int)(175*Math.Pow(1-(i-core)/(double)(glow-core),2.2)),77,124,254);
          using (var pen = new Pen(color,1)) g.DrawRectangle(pen,i,i,width-2*i-1,height-2*i-1);
        }
        g.CompositingMode = CompositingMode.SourceOver;
        // Status pill: live dot, the user's text, then an Esc (or Esc / custom) keycap.
        using (var font = new Font("Microsoft YaHei UI",10.5f*scale,FontStyle.Regular,GraphicsUnit.Point))
        using (var keyFont = new Font("Segoe UI",8.5f*scale,FontStyle.Bold,GraphicsUnit.Point))
        using (var hintFont = new Font("Microsoft YaHei UI",9.5f*scale,FontStyle.Regular,GraphicsUnit.Point))
        using (var measure = new StringFormat(StringFormat.GenericTypographic) { FormatFlags = StringFormatFlags.NoWrap | StringFormatFlags.MeasureTrailingSpaces }) {
          string hint = Words.Get("stopHint");
          string keyLabel = String.IsNullOrEmpty(stopShortcut) ? "Esc" : "Esc / " + stopShortcut;
          float pillHeight=40*scale, padding=16*scale, dot=8*scale, gap=10*scale, keyHeight=20*scale;
          float keyWidth=g.MeasureString(keyLabel,keyFont,PointF.Empty,measure).Width+12*scale;
          float hintWidth=g.MeasureString(hint,hintFont,PointF.Empty,measure).Width;
          float fixedWidth=padding*2+dot+gap*3+1+keyWidth+6*scale+hintWidth;
          float textWidth=Math.Min(g.MeasureString(text,font,PointF.Empty,measure).Width,Math.Max(48*scale,width-48*scale-fixedWidth));
          float pillWidth=fixedWidth+textWidth;
          float x=(float)Math.Round((width-pillWidth)/2), y=position=="bottom"?height-pillHeight-24*scale:24*scale, middle=y+pillHeight/2;
          for (int i=1;i<=6;i++)
            using (var shadow=Rounded(new RectangleF(x-i,y-i+2*scale,pillWidth+2*i,pillHeight+2*i),pillHeight/2+i))
            using (var brush=new SolidBrush(Color.FromArgb(9,0,0,0))) g.FillPath(brush,shadow);
          using (var shape=Rounded(new RectangleF(x,y,pillWidth,pillHeight),pillHeight/2)) {
            using (var fill=new SolidBrush(Color.FromArgb(238,20,22,28))) g.FillPath(fill,shape);
            using (var outline=new Pen(Color.FromArgb(40,255,255,255),1)) g.DrawPath(outline,shape);
          }
          float cursor=x+padding;
          using (var halo=new SolidBrush(Color.FromArgb(64,86,134,254))) g.FillEllipse(halo,cursor-3*scale,middle-dot/2-3*scale,dot+6*scale,dot+6*scale);
          using (var fill=new SolidBrush(Color.FromArgb(255,86,134,254))) g.FillEllipse(fill,cursor,middle-dot/2,dot,dot);
          cursor+=dot+gap;
          using (var brush=new SolidBrush(Color.FromArgb(255,245,247,250)))
          using (var format=new StringFormat(StringFormat.GenericTypographic) { LineAlignment=StringAlignment.Center, Trimming=StringTrimming.EllipsisCharacter, FormatFlags=StringFormatFlags.NoWrap })
            g.DrawString(text,font,brush,new RectangleF(cursor,y,textWidth+1,pillHeight),format);
          cursor+=textWidth+gap;
          using (var line=new Pen(Color.FromArgb(56,255,255,255),1)) g.DrawLine(line,cursor,middle-8*scale,cursor,middle+8*scale);
          cursor+=1+gap;
          var key=new RectangleF(cursor,middle-keyHeight/2,keyWidth,keyHeight);
          using (var shape=Rounded(key,5*scale)) {
            using (var fill=new SolidBrush(Color.FromArgb(34,255,255,255))) g.FillPath(fill,shape);
            using (var outline=new Pen(Color.FromArgb(64,255,255,255),1)) g.DrawPath(outline,shape);
          }
          using (var brush=new SolidBrush(Color.FromArgb(255,245,247,250)))
          using (var format=new StringFormat(StringFormat.GenericTypographic) { Alignment=StringAlignment.Center, LineAlignment=StringAlignment.Center })
            g.DrawString(keyLabel,keyFont,brush,key,format);
          cursor+=keyWidth+6*scale;
          using (var brush=new SolidBrush(Color.FromArgb(200,245,247,250)))
          using (var format=new StringFormat(StringFormat.GenericTypographic) { LineAlignment=StringAlignment.Center, FormatFlags=StringFormatFlags.NoWrap })
            g.DrawString(hint,hintFont,brush,new RectangleF(cursor,y,hintWidth+2,pillHeight),format);
        }
      }
      return image;
    }
    internal static GraphicsPath Rounded(RectangleF r,float radius) {
      var p=new GraphicsPath(); float d=radius*2;
      p.AddArc(r.X,r.Y,d,d,180,90);p.AddArc(r.Right-d,r.Y,d,d,270,90);p.AddArc(r.Right-d,r.Bottom-d,d,d,0,90);p.AddArc(r.X,r.Bottom-d,d,d,90,90);p.CloseFigure();return p;
    }
    protected override void Dispose(bool disposing) {
      if (dc!=IntPtr.Zero) { Native.SelectObject(dc,previous); Native.DeleteObject(bitmap); Native.DeleteDC(dc); dc=IntPtr.Zero; }
      base.Dispose(disposing);
    }
  }
}
