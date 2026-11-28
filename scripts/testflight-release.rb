# Distribute an explicitly selected formal iOS build to the existing Testers group.
# Apple API reference: https://developer.apple.com/documentation/appstoreconnectapi/beta-app-review-submissions
require 'base64'
require 'json'
require 'net/http'
require 'openssl'
require 'uri'
$stdout.sync = true

def b64(value)
  Base64.urlsafe_encode64(value, padding: false)
end

def api(method, path, payload = nil, query = {})
  now = Time.now.to_i
  header = b64(JSON.generate(alg: 'ES256', kid: ENV.fetch('APP_STORE_CONNECT_KEY_ID'), typ: 'JWT'))
  claims = b64(JSON.generate(iss: ENV.fetch('APP_STORE_CONNECT_ISSUER_ID'), iat: now, exp: now + 600, aud: 'appstoreconnect-v1'))
  message = "#{header}.#{claims}"
  key = OpenSSL::PKey.read(Base64.decode64(ENV.fetch('APP_STORE_CONNECT_API_KEY')))
  der = key.dsa_sign_asn1(OpenSSL::Digest::SHA256.digest(message))
  signature = OpenSSL::ASN1.decode(der).value.map { |n| [n.value.to_i.to_s(16).rjust(64, '0')].pack('H*') }.join
  uri = URI("https://api.appstoreconnect.apple.com#{path}")
  uri.query = URI.encode_www_form(query) unless query.empty?
  request = Net::HTTP.const_get(method.capitalize).new(uri)
  request['Authorization'] = "Bearer #{message}.#{b64(signature)}"
  request['Content-Type'] = 'application/json'
  request.body = JSON.generate(payload) if payload
  response = Net::HTTP.start(uri.host, uri.port, use_ssl: true, open_timeout: 30, read_timeout: 60) { |http| http.request(request) }
  raise "ASC #{method} #{path}: #{response.code} #{response.body}" unless response.is_a?(Net::HTTPSuccess)
  response.body.to_s.empty? ? {} : JSON.parse(response.body)
end

# The tester notes for a release: the summary of its notes doc
# (docs/releases/*-X.Y.Z.md) and a link to the whole of it.
# TestFlight's "What to Test" holds at most 4,000 characters.
def whats_new_from_notes(markdown, url = nil)
  lines = markdown.to_s.lines.map(&:strip)
  title = lines.find { |l| l.start_with?('# ') }.to_s.sub(/\A#\s+/, '')
  subject = title.sub(/\Av?\d+\.\d+\.\d+\s*(?::\s*)?/, '').strip
  if subject.empty?
    # A bare "# vX.Y.Z" title: take the first paragraph after it.
    start = lines.index { |l| l.start_with?('# ') }
    rest = start ? lines[(start + 1)..] : lines
    subject = rest.drop_while(&:empty?).take_while { |l| !l.empty? && !l.start_with?('#') }.join(' ')
  end
  text = [subject, url && "Release notes: #{url}", TestFlightRelease::TEST_PROMPT].compact.reject(&:empty?).join("\n\n")
  text.length > 4000 ? "#{text[0, 3999]}…" : text
end

class TestFlightRelease
  APP = '6807904930'
  TEST_PROMPT = 'Please test pairing, reopening the app and terminal input.'
  PROCESSING_FAILED = %w[FAILED INVALID].freeze
  REVIEWED_STATES = %w[WAITING_FOR_BETA_REVIEW IN_BETA_REVIEW BETA_APPROVED READY_FOR_BETA_TESTING IN_BETA_TESTING].freeze

  # wait: seconds to keep polling while Apple still processes the upload or
  # updates the build's beta state (a release run starts right after the
  # upload); 0 fails at once, as a hand-dispatched preview should.
  def initialize(client, version, number, apply: false, whats_new: nil, wait: 0, interval: 30, sleeper: ->(s) { sleep(s) })
    raise 'Expected a stable marketing version' unless version.match?(/\A\d+\.\d+\.\d+\z/)
    raise 'Invalid numeric build number' unless number.match?(/\A\d+(?:\.\d+){0,2}\z/)
    @client, @version, @number, @apply = client, version, number, apply
    @wait, @interval, @sleeper = wait, interval, sleeper
    @whats_new = whats_new.to_s.strip
    @whats_new = TEST_PROMPT if @whats_new.empty?
  end

  # Calls the block until it returns a value, for at most @wait seconds;
  # then raises the block's last reason.
  def poll(what)
    waited = 0
    loop do
      value, reason = yield
      return value if value
      raise reason if waited >= @wait
      puts "Waiting for #{what}: #{reason}"
      @sleeper.call(@interval)
      waited += @interval
    end
  end

  def call(method, path, payload = nil, query = {})
    @client.call(method, path, payload, query)
  end

  def run
    # Build numbers are not unique across marketing versions: release builds
    # number from release.yml's run and manual RCs from mobile-ios.yml's, so
    # both can reach e.g. 25.1. Narrow by the marketing version too.
    build = poll("build #{@number} of #{@version}") do
      builds = call('get', '/v1/builds', nil, 'filter[app]' => APP, 'filter[version]' => @number,
                    'filter[preReleaseVersion.version]' => @version)['data']
      raise "Expected one uploaded build #{@number} of #{@version}, found #{builds.length}" if builds.length > 1
      next [nil, "Expected one uploaded build #{@number} of #{@version}, found none"] if builds.empty?
      processing = builds.first['attributes']['processingState']
      raise "Build processing #{processing}" if PROCESSING_FAILED.include?(processing)
      processing == 'VALID' ? [builds.first] : [nil, "Build is not processed and valid (#{processing})"]
    end
    id = build.fetch('id')
    raise 'Build is expired' if build['attributes']['expired']
    release = call('get', "/v1/builds/#{id}/preReleaseVersion")['data']
    raise 'Marketing version does not match release tag' unless release['attributes']['version'] == @version
    raise 'Expected an iOS build' unless release['attributes']['platform'] == 'IOS'

    groups = call('get', '/v1/betaGroups', nil, 'filter[app]' => APP)['data']
    matches = groups.select { |g| g['attributes']['name'] == 'Testers' && g['attributes']['isInternalGroup'] == false }
    raise 'Existing external Testers group not found uniquely' unless matches.length == 1
    group = matches.first

    # The same standard cryptography and no-France classification used by the
    # previously distributed build. Never infer an exemption from missing data.
    previous = call('get', '/v1/builds', nil, 'filter[app]' => APP, 'filter[version]' => '0.6.4')['data'].first
    raise 'Encryption baseline build missing' unless previous
    declaration = call('get', "/v1/builds/#{previous['id']}/appEncryptionDeclaration")['data']
    encryption = if declaration
      a = declaration['attributes']
      raise 'Baseline is not standard-crypto/no-France' unless a['containsThirdPartyCryptography'] == true && a['containsProprietaryCryptography'] == false && a['availableOnFrenchStore'] == false
      current = call('get', "/v1/builds/#{id}/appEncryptionDeclaration")['data']
      raise 'Build already has a different encryption declaration' if current && current['id'] != declaration['id']
      raise 'Build has a conflicting exemption' if !current && build['attributes']['usesNonExemptEncryption'] == false
      current ? nil : {relationships: {appEncryptionDeclaration: {data: {type: 'appEncryptionDeclarations', id: declaration['id']}}}}
    elsif previous['attributes']['usesNonExemptEncryption'] == false
      current = build['attributes']['usesNonExemptEncryption']
      raise 'Build has a conflicting encryption classification' if current == true
      current == false ? nil : {attributes: {usesNonExemptEncryption: false}}
    else
      raise 'Explicit encryption classification missing'
    end

    # Apple supports reading builds from a group, but not GET_RELATED for a
    # build's betaGroups relationship. Check this during preview as well.
    members = call('get', "/v1/betaGroups/#{group['id']}/relationships/builds", nil, 'limit' => '200')
    raise 'Testers group membership is paginated; inspect before distribution' if members.dig('links', 'next')
    attached = members['data'].any? { |b| b['id'] == id }
    # The beta state can still read PROCESSING just after the build turns VALID.
    state = poll('the beta state to settle') do
      s = call('get', "/v1/builds/#{id}/buildBetaDetail")['data']['attributes']['externalBuildState']
      s == 'PROCESSING' ? [nil, 'Beta state is still PROCESSING'] : [s]
    end
    accepted_states = %w[MISSING_EXPORT_COMPLIANCE READY_FOR_BETA_SUBMISSION WAITING_FOR_BETA_REVIEW IN_BETA_REVIEW BETA_APPROVED READY_FOR_BETA_TESTING IN_BETA_TESTING]
    raise "Build needs manual attention: #{state}" unless accepted_states.include?(state)
    report = {version: @version, build: @number, buildId: id, externalBuildState: state, group: 'Testers', apply: @apply, encryptionBaseline: previous['attributes']['version'], whatsNew: @whats_new}
    return report unless @apply

    call('patch', "/v1/builds/#{id}", {data: {type: 'builds', id: id}.merge(encryption)}) if encryption
    localizations = call('get', "/v1/builds/#{id}/betaBuildLocalizations")['data']
    unless localizations.any? { |l| l['attributes']['locale'] == 'en-US' }
      call('post', '/v1/betaBuildLocalizations', data: {type: 'betaBuildLocalizations', attributes: {locale: 'en-US', whatsNew: @whats_new}, relationships: {build: {data: {type: 'builds', id: id}}}})
    end
    call('post', "/v1/betaGroups/#{group['id']}/relationships/builds", data: [{type: 'builds', id: id}]) unless attached

    state = poll('the build to be ready for beta review') do
      s = call('get', "/v1/builds/#{id}/buildBetaDetail")['data']['attributes']['externalBuildState']
      s == 'READY_FOR_BETA_SUBMISSION' || REVIEWED_STATES.include?(s) ? [s] : [nil, "Distribution awaits Apple state update: #{s}; rerun after processing"]
    end
    if state == 'READY_FOR_BETA_SUBMISSION'
      call('post', '/v1/betaAppReviewSubmissions', data: {type: 'betaAppReviewSubmissions', relationships: {build: {data: {type: 'builds', id: id}}}})
    end
    report[:externalBuildState] = call('get', "/v1/builds/#{id}/buildBetaDetail")['data']['attributes']['externalBuildState']
    report
  end
end

if __FILE__ == $PROGRAM_NAME
  whats_new = ENV['WHATS_NEW'].to_s.strip
  notes = ENV['NOTES_PATH'].to_s
  whats_new = whats_new_from_notes(File.read(notes), ENV['NOTES_URL']) if whats_new.empty? && !notes.empty? && File.exist?(notes)
  report = TestFlightRelease.new(method(:api), ENV.fetch('RELEASE_VERSION'), ENV.fetch('BUILD_NUMBER'),
                                 apply: ENV['APPLY_DISTRIBUTION'] == 'true', whats_new: whats_new,
                                 wait: (ENV.fetch('WAIT_MINUTES', '0').to_f * 60).to_i).run
  puts JSON.pretty_generate(report)
  File.write(ENV.fetch('REPORT_PATH', 'testflight-release.json'), JSON.pretty_generate(report) + "\n")
end
