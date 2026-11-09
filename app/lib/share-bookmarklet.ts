// Runs on the page the member is reading, not on tomola; values are carried as query text only.
export function shareBookmarklet(baseUrl: string): string {
  const destination = JSON.stringify(`${baseUrl}/t/new`);
  return `javascript:(()=>{const u=new URL(${destination});u.searchParams.set('url',location.href);u.searchParams.set('title',document.title);const s=String(getSelection()).trim();if(s)u.searchParams.set('text',s.slice(0,1000));window.open(u,'_blank','noopener')})()`;
}
