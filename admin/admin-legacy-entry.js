// Old bookmarks return to the same static entry; secrets are never placed in this URL.
const fragment = /^#panel\/[a-z]+$/.test(location.hash) ? location.hash : '';
location.replace('/admin/' + fragment);
