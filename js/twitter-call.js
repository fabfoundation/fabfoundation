
/*Display a tweet by id*/
$.getJSON("https://twitter.madeat.eu/1.1/statuses/show/1051427614605205505", function(data) {
  var tweet = linkify(data.text);
  $(".tweet").html(tweet);
});


/* Edit the twitter id on display
tweet(1051790099682340864);
*/
/* Do not edit
function tweet(id) {
  $.getJSON("https://twitter.madeat.eu/1.1/statuses/show/" + id, function(data) {
    var tweet = linkify(data.text);
    $('.tweet').html(tweet);
  });
}
*/ 

function linkify(inputText) {
  var replacedText, replacePattern1, replacePattern2, replacePattern3;

  //URLs starting with http://, https://, or ftp://
  replacePattern1 = /(\b(https?|ftp):\/\/[-A-Z0-9+&@#\/%?=~_|!:,.;]*[-A-Z0-9+&@#\/%=~_|])/gim;
  replacedText = inputText.replace(replacePattern1, '<a href="$1" target="_blank">$1</a>');

  //URLs starting with "www." (without // before it, or it'd re-link the ones done above).
  replacePattern2 = /(^|[^\/])(www\.[\S]+(\b|$))/gim;
  replacedText = replacedText.replace(replacePattern2, '$1<a href="http://$2" target="_blank">$2</a>');

  //Change email addresses to mailto:: links.
  replacePattern3 = /(([a-zA-Z0-9\-\_\.])+@[a-zA-Z\_]+?(\.[a-zA-Z]{2,6})+)/gim;
  replacedText = replacedText.replace(replacePattern3, '<a href="mailto:$1">$1</a>');

  return replacedText;
}